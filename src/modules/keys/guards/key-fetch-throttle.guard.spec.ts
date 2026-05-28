import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { KeyFetchThrottleGuard } from './key-fetch-throttle.guard';

function makeContext(
  requesterId: number | string,
  targetUserId: number | string,
): ExecutionContext {
  const req = {
    user: { userId: requesterId },
    params: { id_user: targetUserId },
    ip: '127.0.0.1',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('KeyFetchThrottleGuard', () => {
  let guard: KeyFetchThrottleGuard;

  beforeEach(() => {
    guard = new KeyFetchThrottleGuard();
  });

  it('allows unlimited self-fanout requests (requester === target)', () => {
    const ctx = makeContext(42, 42);
    for (let i = 0; i < 100; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('still applies self bypass when ids are numeric vs string', () => {
    const ctx = makeContext('42', 42);
    for (let i = 0; i < 100; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('allows up to MAX_REQUESTS (30 default) for a peer, then 429s', () => {
    const ctx = makeContext(1, 2);
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
    try {
      guard.canActivate(ctx);
      throw new Error('expected guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  });

  it('tracks buckets independently per (requester, target) pair', () => {
    const peerA = makeContext(1, 2);
    const peerB = makeContext(1, 3);
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(peerA)).toBe(true);
    }
    // 31st call to peerA throws, but peerB bucket is independent
    expect(() => guard.canActivate(peerA)).toThrow(HttpException);
    for (let i = 0; i < 30; i++) {
      expect(guard.canActivate(peerB)).toBe(true);
    }
  });
});
