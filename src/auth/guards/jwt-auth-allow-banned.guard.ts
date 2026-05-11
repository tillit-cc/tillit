import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';

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
      user?: { userId: number };
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

    req.user = { userId: payload.sub };
    return true;
  }
}
