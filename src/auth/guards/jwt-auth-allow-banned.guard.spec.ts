import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

// libsignal is a native ESM addon — mock it before importing modules that
// transitively pull it in (AuthService → '@signalapp/libsignal-client').
jest.mock('@signalapp/libsignal-client', () => ({
  PublicKey: { deserialize: jest.fn() },
}));

import { JwtAuthAllowBannedGuard } from './jwt-auth-allow-banned.guard';
import { AuthService } from '../auth.service';

describe('JwtAuthAllowBannedGuard', () => {
  let authService: { validateJWT: jest.Mock };
  let guard: JwtAuthAllowBannedGuard;

  beforeEach(() => {
    authService = { validateJWT: jest.fn() };
    guard = new JwtAuthAllowBannedGuard(authService as unknown as AuthService);
  });

  const makeCtx = (
    authHeader?: string,
  ): { ctx: ExecutionContext; req: any } => {
    const req: any = {
      headers: authHeader ? { authorization: authHeader } : {},
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  };

  it('lets a normal access token through and attaches the user', () => {
    authService.validateJWT.mockReturnValue({ sub: 42, deviceId: 3 });
    const { ctx, req } = makeCtx('Bearer abc');

    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.user).toEqual({ userId: 42, deviceId: 3 });
  });

  // A recovery-scoped JWT must NOT be able to delete the account. The
  // account-deletion endpoint deliberately bypasses the ban check, so the
  // scope refusal here is the only thing standing between a leaked recovery
  // token and a permanent data-loss action.
  it('refuses a recovery-scoped JWT with RECOVERY_TOKEN_DENIED', () => {
    authService.validateJWT.mockReturnValue({
      sub: 42,
      deviceId: 1,
      scope: 'recover',
    });
    const { ctx } = makeCtx('Bearer abc');

    let caught: unknown;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    expect(caught).toMatchObject({
      response: { error: 'RECOVERY_TOKEN_DENIED' },
    });
  });

  it('rejects a missing Authorization header', () => {
    const { ctx } = makeCtx();
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer scheme', () => {
    const { ctx } = makeCtx('Basic abc');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects a payload without sub', () => {
    authService.validateJWT.mockReturnValue({ deviceId: 1 });
    const { ctx } = makeCtx('Bearer abc');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
