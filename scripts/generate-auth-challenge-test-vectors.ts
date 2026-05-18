/**
 * Generates regression-test vectors for the v1 domain-separated auth challenge.
 *
 * Output: `_shared/api/auth-challenge-test-vectors.json` (workspace-shared
 * fixture, consumed by both backend and frontend tests).
 *
 * Each vector pins:
 *   - identityPrivateKey / identityPublicKey (Curve25519, base64)
 *   - host, nonce (base64), expectedMessage (base64)
 *   - sampleSignature: an XEdDSA signature that verifies under
 *     identityPublicKey against expectedMessage. XEdDSA is randomized, so this
 *     is a *known-good sample*, not a deterministic value — re-generating with
 *     the same key+message produces a different but also valid signature. Both
 *     sides verify the pinned sampleSignature; fresh signatures are validated
 *     independently against the same expectedMessage.
 *
 * Run with: `pnpm exec tsx scripts/generate-auth-challenge-test-vectors.ts`
 * or with ts-node. Re-running rotates sampleSignature/keys; check in the
 * resulting file once.
 */

import { PrivateKey } from '@signalapp/libsignal-client';
import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { AuthHostService } from '../src/auth/services/auth-host.service';

interface Vector {
  description: string;
  host: string;
  identityPrivateKey: string;
  identityPublicKey: string;
  nonce: string;
  expectedMessage: string;
  sampleSignature: string;
}

const CASES = [
  { description: 'Standard hostname', host: 'api.tillit.cc' },
  {
    description: 'Tor hidden service',
    host: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678.onion',
  },
];

function buildVector({
  description,
  host,
}: {
  description: string;
  host: string;
}): Vector {
  const priv = PrivateKey.generate();
  const pub = priv.getPublicKey();
  const nonce = randomBytes(32);

  const message = AuthHostService.buildChallengeMessage(host, nonce);
  const signature = priv.sign(message);

  if (!pub.verify(message, signature)) {
    throw new Error(`Self-verification failed for case "${description}"`);
  }

  return {
    description,
    host,
    identityPrivateKey: Buffer.from(priv.serialize()).toString('base64'),
    identityPublicKey: Buffer.from(pub.serialize()).toString('base64'),
    nonce: nonce.toString('base64'),
    expectedMessage: message.toString('base64'),
    sampleSignature: Buffer.from(signature).toString('base64'),
  };
}

function main(): void {
  const vectors = CASES.map(buildVector);

  const output = {
    spec: 'TilliT-Auth-Challenge-v1',
    note:
      'Test vectors for the domain-separated auth challenge. See ' +
      '_shared/api/auth-challenge-domain-separation.md. expectedMessage = ' +
      'utf8("TilliT-Auth-Challenge-v1\\n" + host + "\\n") || nonce. ' +
      'sampleSignature is a randomized XEdDSA signature — verifiers must ' +
      'check it against identityPublicKey + expectedMessage, NOT compare ' +
      'byte-for-byte.',
    vectors,
  };

  const outputPath = resolve(
    homedir(),
    '.jack/workspaces/tillit/_shared/api/auth-challenge-test-vectors.json',
  );

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${vectors.length} vectors → ${outputPath}`);
}

main();
