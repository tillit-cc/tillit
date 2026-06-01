import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { RECOVERY_SCOPE } from '../../common/types/authenticated-request';

/**
 * Variant of JwtAuthGuard that skips the ban check.
 *
 * Account deletion must remain reachable for banned users so they can
 * exercise their GDPR Art. 17 right to erasure — the standard guard would
 * reject them with 401 BANNED.
 */
@Injectable()
export class JwtAuthAllowBannedGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: { userId: number; deviceId: number };
    }>();

    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid token');
    }

    const token = header.slice('Bearer '.length).trim();
    const payload = this.authService.validateJWT(token);

    if (!payload?.sub || typeof payload.sub !== 'number') {
      throw new UnauthorizedException('Invalid token payload');
    }

    // Recovery-scoped tokens (ADR-0010 OQ-1) must never reach
    // account-deletion or anything else outside POST /keys recover-primary.
    if (payload.scope === RECOVERY_SCOPE) {
      throw new UnauthorizedException(
        'Recovery token not allowed for this endpoint',
        'RECOVERY_TOKEN_DENIED',
      );
    }

    const deviceId =
      typeof payload.deviceId === 'number' && payload.deviceId > 0
        ? payload.deviceId
        : 1;

    req.user = { userId: payload.sub, deviceId };
    return true;
  }
}
