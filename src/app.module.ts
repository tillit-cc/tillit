import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/app/config.module';
import { DatabaseModule } from './database/mariadb/database.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { KeysModule } from './modules/keys/keys.module';
import { SenderKeysModule } from './modules/sender-keys/sender-keys.module';
import { DdnsModule } from './modules/ddns/ddns.module';
import { MediaModule } from './modules/media/media.module';
import { BanModule } from './modules/ban/ban.module';
import { ModerationModule } from './modules/moderation/moderation.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL_MS || '60000', 10),
        limit: parseInt(process.env.THROTTLE_GLOBAL_LIMIT || '60', 10),
      },
    ]),
    AuthModule,
    ChatModule,
    KeysModule,
    SenderKeysModule,
    DdnsModule,
    MediaModule,
    BanModule,
    ModerationModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }, AppService],
})
export class AppModule {}
