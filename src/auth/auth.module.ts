import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ChallengeStore } from './services/challenge.store';
import { User } from '../entities/user.entity';
import { PushToken } from '../entities/push-token.entity';
import { SignalKey } from '../entities/signal-key.entity';
import { JwtConfigModule } from '../config/jwt/config.module';
import { JwtConfigService } from '../config/jwt/config.service';
import { RedisConfigModule } from '../config/database/redis/config.module';
import { RedisKeystore } from '../database/redis/redis';
import { isCloudMode } from '../config/deployment-mode';

// Conditionally include Redis for cloud mode
const conditionalImports = isCloudMode() ? [RedisConfigModule] : [];
const conditionalProviders = isCloudMode() ? [RedisKeystore] : [];

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [JwtConfigModule],
      inject: [JwtConfigService],
      useFactory: (config: JwtConfigService) => ({
        privateKey: config.privateKey,
        publicKey: config.publicKey,
        signOptions: {
          algorithm: 'RS256',
          expiresIn: config.expiresIn as any,
        },
      }),
    }),
    TypeOrmModule.forFeature([User, PushToken, SignalKey]),
    JwtConfigModule,
    ...conditionalImports,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    ChallengeStore,
    ...conditionalProviders,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
