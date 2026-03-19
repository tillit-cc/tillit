import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = parseInt(
  process.env.THROTTLE_KEY_FETCH_PER_TARGET || '3',
  10,
);

interface BucketEntry {
  count: number;
  resetAt: number;
}

/**
 * Per-target throttle guard for key bundle fetching.
 * Limits requests per (requester, targetUser) pair to prevent
 * enumeration or key exhaustion attacks.
 *
 * Operates independently from the global ThrottlerGuard (which limits by IP).
 */
@Injectable()
export class KeyFetchThrottleGuard implements CanActivate {
  private readonly buckets = new Map<string, BucketEntry>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const requesterId = req.user?.userId ?? req.ip;
    const targetUserId = req.params?.id_user ?? 'unknown';
    const key = `key-fetch:${requesterId}:${targetUserId}`;
    const now = Date.now();

    let entry = this.buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.buckets.set(key, entry);
    }

    entry.count++;

    if (entry.count > MAX_REQUESTS) {
      throw new HttpException(
        'Too many key fetch requests for this user',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Lazy cleanup: remove expired entries periodically
    if (this.buckets.size > 1000) {
      for (const [k, v] of this.buckets) {
        if (now >= v.resetAt) this.buckets.delete(k);
      }
    }

    return true;
  }
}
