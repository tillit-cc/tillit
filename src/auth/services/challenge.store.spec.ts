import { Test, TestingModule } from '@nestjs/testing';
import { ChallengeStore } from './challenge.store';
import { RedisKeystore } from '../../database/redis/redis';

// Mock deployment mode to selfhosted (in-memory mode)
jest.mock('../../config/deployment-mode', () => ({
  isCloudMode: jest.fn().mockReturnValue(false),
  isSelfHostedMode: jest.fn().mockReturnValue(true),
  DEPLOYMENT_MODE: 'selfhosted',
  DeploymentMode: { CLOUD: 'cloud', SELFHOSTED: 'selfhosted' },
}));

describe('ChallengeStore (in-memory mode)', () => {
  let store: ChallengeStore;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChallengeStore,
        { provide: RedisKeystore, useValue: undefined },
      ],
    }).compile();

    store = module.get<ChallengeStore>(ChallengeStore);
  });

  afterEach(() => {
    store.onModuleDestroy();
  });

  it('should create challenge with unique ID and nonce', async () => {
    const result = await store.createChallenge('test-key-1');

    expect(result.challengeId).toBeDefined();
    expect(result.challengeId).toHaveLength(32); // 16 bytes hex
    expect(result.nonce).toBeDefined();

    // Second challenge should be different
    const result2 = await store.createChallenge('test-key-2');
    expect(result2.challengeId).not.toBe(result.challengeId);
    expect(result2.nonce).not.toBe(result.nonce);
  });

  it('should consume challenge and return data (one-time use)', async () => {
    const { challengeId } = await store.createChallenge('my-identity-key');

    const challenge = await store.consumeChallenge(challengeId);

    expect(challenge).not.toBeNull();
    expect(challenge!.identityPublicKey).toBe('my-identity-key');
    expect(challenge!.nonce).toBeDefined();
  });

  it('should return null for already consumed challenge', async () => {
    const { challengeId } = await store.createChallenge('my-identity-key');

    // First consume succeeds
    await store.consumeChallenge(challengeId);

    // Second consume returns null
    const result = await store.consumeChallenge(challengeId);
    expect(result).toBeNull();
  });

  it('should return null for expired challenge', async () => {
    jest.useFakeTimers();

    const { challengeId } = await store.createChallenge('my-identity-key');

    // Advance time past TTL (default 60 seconds)
    jest.advanceTimersByTime(61 * 1000);

    const result = await store.consumeChallenge(challengeId);
    expect(result).toBeNull();

    jest.useRealTimers();
  });

  it('should return null for non-existent challengeId', async () => {
    const result = await store.consumeChallenge('non-existent-id');
    expect(result).toBeNull();
  });

  it('cleanup should remove expired challenges', async () => {
    jest.useFakeTimers();

    await store.createChallenge('key-1');
    await store.createChallenge('key-2');

    // Advance past TTL
    jest.advanceTimersByTime(61 * 1000);

    // Create a fresh one after expiration
    const { challengeId: freshId } = await store.createChallenge('key-3');

    // Trigger cleanup by advancing to cleanup interval
    jest.advanceTimersByTime(30 * 1000);

    // The fresh challenge should still work
    const result = await store.consumeChallenge(freshId);
    expect(result).not.toBeNull();
    expect(result!.identityPublicKey).toBe('key-3');

    jest.useRealTimers();
  });
});
