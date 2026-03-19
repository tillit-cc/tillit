import { Injectable, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisKeystore } from '../../database/redis/redis';
import { isCloudMode } from '../../config/deployment-mode';

interface StoredChallenge {
  nonce: string; // Base64-encoded 32-byte nonce
  identityPublicKey: string;
}

const CHALLENGE_TTL_SECONDS = parseInt(
  process.env.CHALLENGE_TTL_SECONDS || '60',
  10,
);
const NONCE_SIZE = 32; // 32 bytes = 256 bits
const REDIS_PREFIX = 'auth:challenge:';

/**
 * Challenge Store for authentication challenge-response flow
 *
 * Stores nonces temporarily with TTL for secure authentication.
 * - Cloud mode: Uses Redis (scalable, multi-instance)
 * - Self-hosted mode: Uses in-memory Map (single-instance)
 */
@Injectable()
export class ChallengeStore implements OnModuleDestroy {
  private readonly memoryStore = new Map<
    string,
    StoredChallenge & { expiresAt: number }
  >();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly useRedis: boolean;

  constructor(
    @Optional() @Inject(RedisKeystore) private readonly redis?: RedisKeystore,
  ) {
    this.useRedis = isCloudMode() && !!this.redis;

    // Only start cleanup interval for in-memory mode
    if (!this.useRedis) {
      this.cleanupInterval = setInterval(
        () => {
          this.cleanupExpired();
        },
        parseInt(process.env.CHALLENGE_CLEANUP_INTERVAL_MS || '30000', 10),
      );
    }
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /**
   * Generate a new challenge for the given identity public key
   * Returns challengeId and nonce (base64)
   */
  async createChallenge(identityPublicKey: string): Promise<{
    challengeId: string;
    nonce: string;
  }> {
    const challengeId = randomBytes(16).toString('hex'); // 32 char hex string
    const nonce = randomBytes(NONCE_SIZE).toString('base64');

    const challenge: StoredChallenge = {
      nonce,
      identityPublicKey,
    };

    if (this.useRedis && this.redis) {
      // Store in Redis with TTL
      await this.redis.set(
        `${REDIS_PREFIX}${challengeId}`,
        JSON.stringify(challenge),
        CHALLENGE_TTL_SECONDS,
      );
    } else {
      // Store in memory with expiration timestamp
      this.memoryStore.set(challengeId, {
        ...challenge,
        expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000,
      });
    }

    return { challengeId, nonce };
  }

  /**
   * Retrieve and consume a challenge (one-time use)
   * Returns the stored challenge or null if not found/expired
   */
  async consumeChallenge(challengeId: string): Promise<StoredChallenge | null> {
    if (this.useRedis && this.redis) {
      // Get and delete atomically from Redis
      const key = `${REDIS_PREFIX}${challengeId}`;
      const data = await this.redis.getdel(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data) as StoredChallenge;
    } else {
      // In-memory mode
      const challenge = this.memoryStore.get(challengeId);

      if (!challenge) {
        return null;
      }

      // Always delete after retrieval (one-time use)
      this.memoryStore.delete(challengeId);

      // Check expiration
      if (Date.now() > challenge.expiresAt) {
        return null;
      }

      return {
        nonce: challenge.nonce,
        identityPublicKey: challenge.identityPublicKey,
      };
    }
  }

  /**
   * Remove expired challenges (in-memory mode only)
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, challenge] of this.memoryStore.entries()) {
      if (now > challenge.expiresAt) {
        this.memoryStore.delete(id);
      }
    }
  }
}
