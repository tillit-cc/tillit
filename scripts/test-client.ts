/**
 * TilliT backend test-client — drives the real auth/device wire from the CLI,
 * so the per-device-auth + liveness features can be tested end-to-end WITHOUT
 * the mobile/desktop app, a camera, or a second physical device.
 *
 * Uses the SAME crypto the clients use: @signalapp/libsignal-client
 * (Curve25519 / XEdDSA), and the v1 domain-separated challenge message
 * `utf8("TilliT-Auth-Challenge-v1\n" + host + "\n") || nonce`.
 *
 * It registers fresh accounts (so it never touches your real app data),
 * programmatically links a second device through the full pairing wire
 * (init → share-pubkey → complete → result → keys), and runs the
 * security-relevant scenarios the well-behaved app can't:
 *   - finding #4: a device holding the shared identity key cannot claim
 *     deviceId:1 once device 1 has a bound auth key (401 DEVICE_AUTH_INVALID)
 *   - malformed auth key on first bind → 400 DEVICE_AUTH_KEY_INVALID
 *   - re-binding a different auth key → 409 DEVICE_AUTH_MISMATCH
 *   - transition mode vs DEVICE_AUTH_REQUIRED enforcement
 *   - backward-compat: a PRE-UPDATE client (old app — no device-auth key, no
 *     deviceAuthSignature) keeps logging in against the new backend in
 *     transition mode, and the DEVICE_AUTH_REQUIRED gate fails CLOSED (401).
 *     Pass --expect-enforce when the server runs DEVICE_AUTH_REQUIRED=true.
 *   - liveness lock probe (linked device login while primary is fresh/stale)
 *
 * RUN (from the backend repo root) — baseUrl is REQUIRED (arg or TILLIT_URL env):
 *   pnpm exec ts-node --transpile-only scripts/test-client.ts <baseUrl>
 *   TILLIT_URL=<baseUrl> pnpm exec ts-node --transpile-only scripts/test-client.ts
 *   # e.g. baseUrl = http://<your-lan-ip>:3000
 *
 * The server must allow the host you hit (AUTH_ALLOWED_HOSTS must contain the
 * authority of baseUrl, e.g. <your-lan-ip>:3000) and have a generous auth
 * throttle for the burst of logins, e.g. start it with:
 *   DEPLOYMENT_MODE=selfhosted LOADTEST_MODE=false \
 *   AUTH_ALLOWED_HOSTS=<your-lan-ip>:3000 APP_PORT=3000 LOG_LEVEL=warn \
 *   THROTTLE_AUTH_LIMIT=10000 THROTTLE_GLOBAL_LIMIT=10000 THROTTLE_KEYS_LIMIT=10000 \
 *   pnpm run start:dev
 *
 * Scenario-specific server flags:
 *   - DEVICE_AUTH_REQUIRED=true  → flips the "transition vs enforced" probe
 *   - PRIMARY_LIVENESS_MAX_IDLE_MS=120000 (+ age the primary's last_active_at)
 *                                → makes the liveness probe lock the linked device
 */

import { PrivateKey } from '@signalapp/libsignal-client';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

// ── config ──────────────────────────────────────────────────────────────────
// baseUrl is REQUIRED — a positional arg or the TILLIT_URL env var. No
// hardcoded default: the server's address is deployment-specific and its
// authority must match AUTH_ALLOWED_HOSTS.
// Flags:
//   --liveness      run the liveness-lock scenario (self-contained: it ages the
//                   primary's anchor in the DB, asserts 401 PRIMARY_INACTIVE,
//                   then revives the primary and asserts the unlock).
//   --db <path>     sqlite DB path used by --liveness to age the anchor
//                   (default: sqlite-data/tillit.db; or env TILLIT_DB).
//   --expect-enforce  assert the backward-compat scenario against a server with
//                   DEVICE_AUTH_REQUIRED=true (legacy re-login must fail closed
//                   with 401 DEVICE_AUTH_REQUIRED instead of 2xx).
const ARGV = process.argv.slice(2);
const ARG = ARGV.find((a) => /^https?:\/\//.test(a)) || process.env.TILLIT_URL;
const WANT_LIVENESS = ARGV.includes('--liveness');
const EXPECT_ENFORCE = ARGV.includes('--expect-enforce');
const dbFlagIdx = ARGV.indexOf('--db');
const DB_PATH =
  (dbFlagIdx >= 0 ? ARGV[dbFlagIdx + 1] : process.env.TILLIT_DB) ||
  'sqlite-data/tillit.db';
if (!ARG) {
  console.error(
    'baseUrl mancante.\n' +
      '  Usage: pnpm exec ts-node --transpile-only scripts/test-client.ts <baseUrl> [--liveness] [--db <path>]\n' +
      '     or: TILLIT_URL=<baseUrl> pnpm exec ts-node --transpile-only scripts/test-client.ts\n' +
      "  es. http://192.168.1.50:3000 (l'authority deve essere in AUTH_ALLOWED_HOSTS)",
  );
  process.exit(2);
}
let BASE: string;
let HOST: string;
try {
  BASE = ARG.replace(/\/$/, '');
  HOST = new URL(BASE).host.toLowerCase(); // must match AUTH_ALLOWED_HOSTS
  if (!HOST) throw new Error('no host');
} catch {
  console.error(`baseUrl non valido: "${ARG}" (atteso es. http://192.168.1.50:3000)`);
  process.exit(2);
}

// ── tiny test harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const notes: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗ ${name}${detail ? ` — ${detail}` : ''}\x1b[0m`);
  }
}
function note(s: string) {
  notes.push(s);
  console.log(`  \x1b[33mℹ\x1b[0m ${s}`);
}

// ── crypto helpers ────────────────────────────────────────────────────────────
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

interface KeyPair {
  priv: PrivateKey;
  pubB64: string;
}
function genKeyPair(): KeyPair {
  const priv = PrivateKey.generate();
  return { priv, pubB64: b64(priv.getPublicKey().serialize()) };
}

// Pairing ephemeral keys are raw X25519 (the server validates length === 32);
// they're stored/relayed opaquely, so random 32 bytes is enough for the wire.
const genEphemeral = () => b64(randomBytes(32));

function challengeMessage(nonceB64: string): Buffer {
  const prefix = Buffer.from(`TilliT-Auth-Challenge-v1\n${HOST}\n`, 'utf8');
  return Buffer.concat([prefix, Buffer.from(nonceB64, 'base64')]);
}

const randReg = () => Math.floor(Math.random() * 16000) + 1;

// ── http ──────────────────────────────────────────────────────────────────────
interface Resp {
  status: number;
  data: any;
}
async function http(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Resp> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}
const is2xx = (s: number) => s >= 200 && s < 300;

// ── wire ops ────────────────────────────────────────────────────────────────
interface Account {
  identity: KeyPair; // shared across the account's devices
}
function newAccount(): Account {
  return { identity: genKeyPair() };
}

/** POST /auth/identity for a given device. `deviceAuth` optional (per-device). */
async function authIdentity(
  acct: Account,
  deviceId: number,
  registrationId: number,
  deviceAuth?: KeyPair,
): Promise<Resp> {
  const ch = await http('POST', '/auth/challenge', {
    body: { identityPublicKey: acct.identity.pubB64 },
  });
  if (!is2xx(ch.status)) return ch;
  const msg = challengeMessage(ch.data.nonce);

  const spk = PrivateKey.generate();
  const spkPub = spk.getPublicKey().serialize();
  const body: Record<string, unknown> = {
    identityPublicKey: acct.identity.pubB64,
    registrationId,
    deviceId,
    signedPreKeyPublicKey: b64(spkPub),
    signedPreKeyId: 1,
    signedPreKeySignature: b64(acct.identity.priv.sign(spkPub)),
    challengeId: ch.data.challengeId,
    challengeSignature: b64(acct.identity.priv.sign(msg)),
  };
  if (deviceAuth) body.deviceAuthSignature = b64(deviceAuth.priv.sign(msg));
  return http('POST', '/auth/identity', { body });
}

/** POST /keys. Pass `deviceAuthPublicKey` (string) to bind, or override raw. */
async function uploadKeys(
  acct: Account,
  deviceId: number,
  registrationId: number,
  token: string,
  deviceAuthPublicKey?: string,
): Promise<Resp> {
  const spk = PrivateKey.generate();
  const spkPub = spk.getPublicKey().serialize();
  const body: Record<string, unknown> = {
    deviceId,
    identityPublicKey: acct.identity.pubB64,
    registrationId,
    signedPreKey: {
      keyId: 1,
      keyData: b64(spkPub),
      signature: b64(acct.identity.priv.sign(spkPub)),
    },
    preKeys: Array.from({ length: 5 }, (_, i) => ({
      keyId: i + 1,
      keyData: b64(PrivateKey.generate().getPublicKey().serialize()),
    })),
  };
  if (deviceAuthPublicKey !== undefined)
    body.deviceAuthPublicKey = deviceAuthPublicKey;
  return http('POST', '/keys', { token, body });
}

/** Register a fresh primary (device 1) and bind its device-auth key. */
async function registerPrimary(): Promise<{
  acct: Account;
  reg: number;
  deviceAuth: KeyPair;
  token: string;
  userId: number;
}> {
  const acct = newAccount();
  const reg = randReg();
  const deviceAuth = genKeyPair();
  // First identity: new user → device-auth not required yet (bound at /keys).
  const auth = await authIdentity(acct, 1, reg);
  if (!is2xx(auth.status)) throw new Error(`primary identity failed: ${auth.status} ${JSON.stringify(auth.data)}`);
  const token = auth.data.accessToken as string;
  const userId = auth.data.userId as number;
  // Bind the device-auth key (TOFU).
  const keys = await uploadKeys(acct, 1, reg, token, deviceAuth.pubB64);
  if (!is2xx(keys.status)) throw new Error(`primary keys failed: ${keys.status} ${JSON.stringify(keys.data)}`);
  return { acct, reg, deviceAuth, token, userId };
}

/** Drive the full pairing wire; return the new device's context. Throws on failure. */
async function linkDevice(primary: {
  acct: Account;
  token: string;
}): Promise<{ dev2Id: number; dev2Reg: number; dev2Auth: KeyPair }> {
  const ePub = genEphemeral();
  const init = await http('POST', '/auth/devices/link/init', {
    body: { ephemeralPublicKey: ePub, deviceName: 'liveness-linked', userAgent: 'test-client' },
  });
  if (!is2xx(init.status)) throw new Error(`link/init: ${init.status} ${JSON.stringify(init.data)}`);
  const sessionId = init.data.sessionId;
  const pPub = genEphemeral();
  await http('POST', '/auth/devices/link/share-pubkey', {
    token: primary.token,
    body: { sessionId, primaryEphemeralPublicKey: pPub },
  });
  const payload = b64(Buffer.concat([Buffer.from([1]), randomBytes(12), randomBytes(48), randomBytes(16)]));
  const complete = await http('POST', '/auth/devices/link/complete', {
    token: primary.token,
    body: { sessionId, encryptedPayload: payload },
  });
  if (!is2xx(complete.status)) throw new Error(`link/complete: ${complete.status} ${JSON.stringify(complete.data)}`);
  const dev2Id = complete.data.assignedDeviceId as number;
  const dev2Reg = randReg();
  const dev2Auth = genKeyPair();
  const auth2 = await authIdentity(primary.acct, dev2Id, dev2Reg); // pending_link → transition
  if (!is2xx(auth2.status)) throw new Error(`device2 identity: ${auth2.status} ${JSON.stringify(auth2.data)}`);
  const keys2 = await uploadKeys(primary.acct, dev2Id, dev2Reg, auth2.data.accessToken, dev2Auth.pubB64);
  if (!is2xx(keys2.status)) throw new Error(`device2 keys: ${keys2.status} ${JSON.stringify(keys2.data)}`);
  return { dev2Id, dev2Reg, dev2Auth };
}

/** Age the primary's liveness anchor far into the past via sqlite3. False if it couldn't. */
function ageDb(userId: number): boolean {
  const sql = `UPDATE user_devices SET last_active_at='2000-01-01 00:00:00' WHERE user_id=${userId} AND device_id=1;`;
  try {
    execSync(`sqlite3 '${DB_PATH}' "${sql}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness-lock scenario (ADR-0011), self-contained: register a primary, link a
 * device, age the primary's anchor in the DB, assert the linked device is
 * refused with 401 PRIMARY_INACTIVE, then revive the primary and assert the
 * linked device is unlocked again (soft + reversible, no re-pairing).
 */
async function livenessTest(): Promise<void> {
  console.log(`\nLiveness lock (ADR-0011) — DB: ${DB_PATH}\n`);
  const primary = await registerPrimary();
  // A brand-new primary row has last_active_at = null → grace (allowed). The
  // re-login sets the anchor so the lock can actually engage.
  await authIdentity(primary.acct, 1, primary.reg, primary.deviceAuth);
  const { dev2Id, dev2Reg, dev2Auth } = await linkDevice(primary);
  ok('setup: primary + device 2 linkato', true, `userId=${primary.userId} device2=${dev2Id}`);

  const fresh = await authIdentity(primary.acct, dev2Id, dev2Reg, dev2Auth);
  ok('device 2 login con primary ATTIVO → 2xx', is2xx(fresh.status), `status=${fresh.status}`);

  if (!ageDb(primary.userId)) {
    note(`Non riesco a invecchiare l'anchor via sqlite3 su "${DB_PATH}" (DB assente? cloud/MariaDB? path errato → usa --db). Salto le asserzioni del lock.`);
    return;
  }
  note(`anchor del primary (user ${primary.userId}) invecchiato a 2000-01-01`);

  const locked = await authIdentity(primary.acct, dev2Id, dev2Reg, dev2Auth);
  ok(
    'device 2 login con primary STALE → 401 PRIMARY_INACTIVE',
    locked.status === 401 && locked.data?.error === 'PRIMARY_INACTIVE',
    `status=${locked.status} error=${locked.data?.error ?? locked.data?.message}`,
  );

  // Revive: the primary coming back online refreshes the anchor → unlock.
  await authIdentity(primary.acct, 1, primary.reg, primary.deviceAuth);
  const unlocked = await authIdentity(primary.acct, dev2Id, dev2Reg, dev2Auth);
  ok('primary torna → device 2 login → 2xx (sblocco, no re-pairing)', is2xx(unlocked.status), `status=${unlocked.status}`);
}

function summary(): never {
  console.log(
    `\n\x1b[1mRisultato:\x1b[0m \x1b[32m${passed} PASS\x1b[0m, ${failed ? `\x1b[31m${failed} FAIL\x1b[0m` : '0 FAIL'}`,
  );
  if (notes.length) console.log(`(${notes.length} note informative sopra)`);
  process.exit(failed ? 1 : 0);
}

// ── scenarios ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nTilliT test-client → ${BASE}  (host: ${HOST})\n`);

  // 0. sanity
  const status = await http('GET', '/auth/status').catch(() => null);
  if (!status) {
    console.log(`\x1b[31mServer non raggiungibile su ${BASE}. È avviato? AUTH_ALLOWED_HOSTS contiene ${HOST}?\x1b[0m`);
    process.exit(1);
  }

  // --liveness: run only the focused liveness-lock scenario, then exit.
  if (WANT_LIVENESS) {
    await livenessTest();
    summary();
  }

  // 1. Register a primary with a bound device-auth key
  console.log('1) Registrazione primary (device 1) + bind auth key');
  const primary = await registerPrimary();
  ok('primary registrato', !!primary.token, `userId=${primary.userId}`);
  const reAuth = await authIdentity(primary.acct, 1, primary.reg, primary.deviceAuth);
  ok('re-login con device-auth → 2xx', is2xx(reAuth.status), `status=${reAuth.status}`);

  // 2. finding #4 — la chiave d'identità è condivisa; un device che NON ha la
  //    auth-key del device 1 non può spacciarsi per deviceId:1.
  console.log('\n2) Finding #4 — device condivide identity ma non la auth-key del primary');
  const noSig = await authIdentity(primary.acct, 1, randReg()); // niente deviceAuthSignature
  ok('login deviceId:1 SENZA device-auth → 401', noSig.status === 401, `status=${noSig.status} error=${noSig.data?.error ?? noSig.data?.message}`);
  const wrongAuth = genKeyPair();
  const badSig = await authIdentity(primary.acct, 1, randReg(), wrongAuth); // firma con chiave sbagliata
  ok('login deviceId:1 con device-auth ERRATA → 401', badSig.status === 401, `status=${badSig.status}`);

  // 3. malformed auth key sul primo bind → 400 (la mia validazione anti-brick)
  console.log('\n3) Auth key malformata al primo bind → 400 DEVICE_AUTH_KEY_INVALID');
  {
    const acct = newAccount();
    const reg = randReg();
    const auth = await authIdentity(acct, 1, reg);
    const bad = await uploadKeys(acct, 1, reg, auth.data.accessToken, 'non-è-una-chiave-base64-valida!!!');
    ok('bind chiave malformata → 400', bad.status === 400, `status=${bad.status} error=${bad.data?.error}`);
    ok('  error = DEVICE_AUTH_KEY_INVALID', bad.data?.error === 'DEVICE_AUTH_KEY_INVALID', `${bad.data?.error}`);
  }

  // 4. re-bind di una chiave DIVERSA su device già legato → 409
  console.log('\n4) Re-bind di una auth key diversa → 409 DEVICE_AUTH_MISMATCH');
  {
    const otherKey = genKeyPair();
    const mism = await uploadKeys(primary.acct, 1, primary.reg, primary.token, otherKey.pubB64);
    ok('re-bind chiave diversa → 409', mism.status === 409, `status=${mism.status} error=${mism.data?.error}`);
    // idempotenza: ri-caricare la STESSA chiave → 2xx (no-op)
    const same = await uploadKeys(primary.acct, 1, primary.reg, primary.token, primary.deviceAuth.pubB64);
    ok('re-upload STESSA chiave → 2xx (idempotente)', is2xx(same.status), `status=${same.status}`);
  }

  // 5. Pairing programmatico — linka device 2 (init → share-pubkey → complete → keys)
  console.log('\n5) Pairing: linko un device 2 via wire (no QR/camera)');
  let dev2Id = 0;
  let dev2Reg = 0;
  let dev2Auth: KeyPair | null = null;
  {
    const ePub = genEphemeral(); // ephemeral X25519 del nuovo device (32B)
    const init = await http('POST', '/auth/devices/link/init', {
      body: { ephemeralPublicKey: ePub, deviceName: 'test-linked', userAgent: 'test-client' },
    });
    ok('link/init → sessionId', is2xx(init.status) && !!init.data?.sessionId, `status=${init.status} ${init.data?.message ?? ''}`);
    const sessionId = init.data.sessionId;

    const pPub = genEphemeral(); // ephemeral X25519 del primary (32B)
    const share = await http('POST', '/auth/devices/link/share-pubkey', {
      token: primary.token,
      body: { sessionId, primaryEphemeralPublicKey: pPub },
    });
    ok('link/share-pubkey (primary) → 2xx', is2xx(share.status), `status=${share.status}`);

    // payload opaco ben formato [1B v][12B iv][N ct][16B tag] — il server lo relaya soltanto
    const payload = b64(Buffer.concat([Buffer.from([1]), randomBytes(12), randomBytes(48), randomBytes(16)]));
    const complete = await http('POST', '/auth/devices/link/complete', {
      token: primary.token,
      body: { sessionId, encryptedPayload: payload },
    });
    ok('link/complete (primary) → assignedDeviceId', is2xx(complete.status) && !!complete.data?.assignedDeviceId, `status=${complete.status} deviceId=${complete.data?.assignedDeviceId}`);
    dev2Id = complete.data.assignedDeviceId;

    const result = await http('GET', `/auth/devices/link/session/${sessionId}/result`);
    ok('link/result (new device) → completed', result.data?.status === 'completed', `status=${result.data?.status} assigned=${result.data?.assignedDeviceId}`);

    // Il nuovo device autentica (identity condivisa, deviceId assegnato, riga pending_link → transition)
    dev2Reg = randReg();
    dev2Auth = genKeyPair();
    const auth2 = await authIdentity(primary.acct, dev2Id, dev2Reg); // niente device-auth: non ancora legata
    ok('device 2 login (pending_link) → 2xx', is2xx(auth2.status), `status=${auth2.status}`);
    const keys2 = await uploadKeys(primary.acct, dev2Id, dev2Reg, auth2.data.accessToken, dev2Auth.pubB64);
    ok('device 2 /keys (flip → active, bind auth) → 2xx', is2xx(keys2.status), `status=${keys2.status}`);

    const list = await http('GET', '/auth/devices', { token: primary.token });
    const devices = list.data?.devices ?? [];
    ok('GET /auth/devices elenca 2 device', devices.length === 2, `count=${devices.length}`);
    // device 2 ora ha la SUA auth-key: deve poter loggare CON device-auth
    const auth2b = await authIdentity(primary.acct, dev2Id, dev2Reg, dev2Auth);
    ok('device 2 re-login con la PROPRIA device-auth → 2xx', is2xx(auth2b.status), `status=${auth2b.status}`);
    // ...e device 2 NON può usare la propria firma per spacciarsi da device 1
    const climb = await authIdentity(primary.acct, 1, randReg(), dev2Auth);
    ok('device 2 prova a salire a deviceId:1 → 401', climb.status === 401, `status=${climb.status}`);
  }

  // 6. Backward-compat — un client PRE-UPDATE (app vecchia: nessuna device-auth
  //    key, nessuna deviceAuthSignature) deve continuare a funzionare contro il
  //    backend nuovo finché siamo in transition mode. Sotto enforcement il gate
  //    deve fallire CHIUSO (401 DEVICE_AUTH_REQUIRED) — segnale operativo che
  //    DEVICE_AUTH_REQUIRED NON va flippato finché le app rilasciate non bindano
  //    la device-auth key. È esattamente lo scenario "app vecchia + backend nuovo".
  console.log('\n6) Backward-compat: client pre-update (app vecchia, nessuna device-auth)');
  {
    const acct = newAccount(); // utente "legacy", come l'app attualmente rilasciata
    const reg = randReg();
    // 6a. Primo /auth/identity (utente nuovo): sempre permesso, anche sotto
    //     enforcement — il ramo device-auth scatta solo per utenti già esistenti.
    const first = await authIdentity(acct, 1, reg); // NIENTE deviceAuthSignature
    ok('app vecchia: primo /auth/identity (utente nuovo) → 2xx', is2xx(first.status), `status=${first.status}`);
    // 6b. POST /keys SENZA deviceAuthPublicKey (come l'app vecchia): non deve mai
    //     dare 400/409 e non lega alcuna auth-key (la riga resta in transition).
    const keys = await uploadKeys(acct, 1, reg, first.data.accessToken); // niente authKey
    ok('app vecchia: POST /keys senza deviceAuthPublicKey → 2xx (nessun bind)', is2xx(keys.status), `status=${keys.status} error=${keys.data?.error ?? ''}`);
    // 6c. Re-login SENZA deviceAuthSignature: ciò che l'app vecchia fa a ogni
    //     riavvio / scadenza token. QUESTO è il caso "app vecchia + backend nuovo".
    const relogin = await authIdentity(acct, 1, reg); // niente deviceAuthSignature
    if (EXPECT_ENFORCE) {
      ok(
        'enforcement: re-login app vecchia → 401 DEVICE_AUTH_REQUIRED (gate fail-closed)',
        relogin.status === 401 && relogin.data?.error === 'DEVICE_AUTH_REQUIRED',
        `status=${relogin.status} error=${relogin.data?.error ?? relogin.data?.message}`,
      );
      note('NON flippare DEVICE_AUTH_REQUIRED=true finché le app rilasciate non bindano la device-auth key.');
    } else {
      ok(
        'transition: re-login app vecchia → 2xx (utente pre-update resta operativo)',
        is2xx(relogin.status),
        `status=${relogin.status} error=${relogin.data?.error ?? relogin.data?.message}`,
      );
      // ripetibile, non un one-shot: l'app vecchia deve poter loggare all'infinito
      const relogin2 = await authIdentity(acct, 1, reg);
      ok('transition: l\'app vecchia continua a loggare ripetutamente → 2xx', is2xx(relogin2.status), `status=${relogin2.status}`);
    }
  }

  // 7. Liveness lock probe (dipende da MAX_IDLE del server + freschezza del primary)
  console.log('\n7) Liveness lock (probe — dipende dal server)');
  if (dev2Auth) {
    const probe = await authIdentity(primary.acct, dev2Id, dev2Reg, dev2Auth);
    if (is2xx(probe.status)) {
      note('device 2 login → 2xx: il primary risulta ATTIVO (atteso, l\'abbiamo appena usato).');
      note('Per vedere il LOCK: avvia il server con PRIMARY_LIVENESS_MAX_IDLE_MS=120000, poi invecchia l\'anchor del primary nel DB e rilancia questo script con --liveness, oppure:');
      note(`  sqlite3 sqlite-data/tillit.db "UPDATE user_devices SET last_active_at='2020-01-01' WHERE user_id=${primary.userId} AND device_id=1;"  → poi un login di device 2 deve dare 401 PRIMARY_INACTIVE`);
    } else if (probe.status === 401 && probe.data?.error === 'PRIMARY_INACTIVE') {
      ok('device 2 login con primary inattivo → 401 PRIMARY_INACTIVE', true);
    } else {
      note(`device 2 login → status ${probe.status} error=${probe.data?.error}`);
    }
  }

  summary();
}

main().catch((e) => {
  console.error('\x1b[31mErrore inatteso:\x1b[0m', e);
  process.exit(2);
});
