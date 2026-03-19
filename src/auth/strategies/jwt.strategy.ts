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

  async validate(payload: { sub?: number }) {
    if (!payload.sub || typeof payload.sub !== 'number') {
      throw new UnauthorizedException('Invalid token payload');
    }

    if (await this.banService.isUserBanned(payload.sub)) {
      throw new UnauthorizedException('User is banned', 'BANNED');
    }

    return {
      userId: payload.sub,
    };
  }
}
