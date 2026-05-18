import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ChallengeStore } from './services/challenge.store';
import { AuthHostService } from './services/auth-host.service';
import { AccountDeletionService } from './services/account-deletion.service';
import { JwtAuthAllowBannedGuard } from './guards/jwt-auth-allow-banned.guard';
import { User } from '../entities/user.entity';
import { PushToken } from '../entities/push-token.entity';
import { SignalKey } from '../entities/signal-key.entity';
import { Room } from '../entities/room.entity';
import { RoomUser } from '../entities/room-user.entity';
import { PendingMessage } from '../entities/pending-message.entity';
import { MediaBlob } from '../entities/media-blob.entity';
import { Report } from '../entities/report.entity';
import { SenderKeyDistribution } from '../entities/sender-key-distribution.entity';
import { JwtConfigModule } from '../config/jwt/config.module';
import { JwtConfigService } from '../config/jwt/config.service';
import { RedisConfigModule } from '../config/database/redis/config.module';
import { RedisKeystore } from '../database/redis/redis';
import { MediaConfigModule } from '../config/media/config.module';
import { ChatModule } from '../modules/chat/chat.module';
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
    TypeOrmModule.forFeature([
      User,
      PushToken,
      SignalKey,
      Room,
      RoomUser,
      PendingMessage,
      MediaBlob,
      Report,
      SenderKeyDistribution,
    ]),
    JwtConfigModule,
    MediaConfigModule,
    ChatModule,
    ...conditionalImports,
  ],
  providers: [
    AuthService,
    JwtStrategy,
    ChallengeStore,
    AuthHostService,
    AccountDeletionService,
    JwtAuthAllowBannedGuard,
    ...conditionalProviders,
  ],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
