import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { JwtConfigService } from '../../config/jwt/config.service';
import { BanService } from '../../modules/ban/ban.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private jwtConfig: JwtConfigService,
    private banService: BanService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtConfig.publicKey,
      algorithms: ['RS256'],
    });
  }

  async validate(payload: { sub?: number; deviceId?: number }) {
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

    return {
      userId: payload.sub,
      deviceId,
    };
  }
}
