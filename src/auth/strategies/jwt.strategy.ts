import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { JwtConfigService } from '../../config/jwt/config.service';
import { BanService } from '../../modules/ban/ban.service';
import { DeviceLinkService } from '../services/device-link.service';
import {
  RECOVERY_SCOPE,
  type JwtScope,
} from '../../common/types/authenticated-request';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private jwtConfig: JwtConfigService,
    private banService: BanService,
    private deviceLinkService: DeviceLinkService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtConfig.publicKey,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: { sub?: number; deviceId?: number; scope?: string }) {
    if (!payload.sub || typeof payload.sub !== 'number') {
      throw new UnauthorizedException('Invalid token payload');
    }

    if (await this.banService.isUserBanned(payload.sub)) {
      throw new UnauthorizedException('User is banned', 'BANNED');
    }

    // Legacy tokens (pre-multi-device) carry no deviceId — fallback to 1
    // matches the single-device reality on the wire today.
    const deviceId =
      typeof payload.deviceId === 'number' && payload.deviceId > 0
        ? payload.deviceId
        : 1;

    // A revoked device may still hold a valid JWT (it expires only on TTL).
    // Force logout by rejecting the token with a distinct error code so the
    // client can wipe local state instead of retrying.
    if (await this.deviceLinkService.isDeviceRevoked(payload.sub, deviceId)) {
      throw new UnauthorizedException('Device revoked', 'DEVICE_REVOKED');
    }

    // Pass `scope` through to req.user so the JwtAuthGuard / per-handler
    // metadata can confine recovery-scoped tokens (ADR-0010 OQ-1). Only
    // explicitly-known scopes propagate; anything unknown is dropped.
    const scope: JwtScope | undefined =
      payload.scope === RECOVERY_SCOPE ? RECOVERY_SCOPE : undefined;

    return {
      userId: payload.sub,
      deviceId,
      ...(scope ? { scope } : {}),
    };
  }
}
