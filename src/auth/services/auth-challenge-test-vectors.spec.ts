import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { AuthHostService } from './auth-host.service';

/**
 * Regression test against the workspace-shared test-vector fixture. The same
 * file is consumed by the client (tillit-native) so that any divergence in the
 * domain-separated message construction is caught on both sides.
 *
 * We only check the deterministic parts here (message construction + fixture
 * shape). XEdDSA signature verification is exercised:
 *   1. At fixture generation time — `scripts/generate-auth-challenge-test-vectors.ts`
 *      self-verifies every sampleSignature before writing the file.
 *   2. End-to-end via auth.service.spec.ts (with libsignal-client mocked under
 *      the unit jest config).
 */
const FIXTURE_PATH = resolve(
  homedir(),
  '.jack/workspaces/tillit/_shared/api/auth-challenge-test-vectors.json',
);

interface Vector {
  description: string;
  host: string;
  identityPrivateKey: string;
  identityPublicKey: string;
  nonce: string;
  expectedMessage: string;
  sampleSignature: string;
}

interface Fixture {
  spec: string;
  vectors: Vector[];
}

describe('Auth challenge test vectors (shared fixture)', () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  });

  it('uses the v1 spec tag', () => {
    expect(fixture.spec).toBe('TilliT-Auth-Challenge-v1');
  });

  it('contains at least two vectors', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(2);
  });

  it('each vector has all required fields', () => {
    for (const v of fixture.vectors) {
      expect(typeof v.host).toBe('string');
      expect(v.host.length).toBeGreaterThan(0);
      expect(typeof v.identityPrivateKey).toBe('string');
      expect(typeof v.identityPublicKey).toBe('string');
      expect(typeof v.nonce).toBe('string');
      expect(typeof v.expectedMessage).toBe('string');
      expect(typeof v.sampleSignature).toBe('string');
    }
  });

  it('reconstructs expectedMessage from host + nonce via buildChallengeMessage', () => {
    for (const v of fixture.vectors) {
      const nonce = Buffer.from(v.nonce, 'base64');
      const built = AuthHostService.buildChallengeMessage(v.host, nonce);
      expect(built.toString('base64')).toBe(v.expectedMessage);
    }
  });

  it('expectedMessage starts with the v1 domain separator + host + LF', () => {
    for (const v of fixture.vectors) {
      const messageBytes = Buffer.from(v.expectedMessage, 'base64');
      const expectedPrefix = Buffer.from(
        `TilliT-Auth-Challenge-v1\n${v.host}\n`,
        'utf8',
      );
      expect(
        messageBytes.subarray(0, expectedPrefix.length).equals(expectedPrefix),
      ).toBe(true);
    }
  });
});
