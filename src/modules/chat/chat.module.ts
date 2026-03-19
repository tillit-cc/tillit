import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Room } from '../../entities/room.entity';
import { RoomUser } from '../../entities/room-user.entity';
import { User } from '../../entities/user.entity';
import { PushToken } from '../../entities/push-token.entity';
import { PendingMessage } from '../../entities/pending-message.entity';
import { MediaBlob } from '../../entities/media-blob.entity';
import { ChatGateway } from './gateways/chat.gateway';
import { MessageService } from './services/message.service';
import { RoomService } from './services/room.service';
import { ChatController } from './controllers/chat.controller';
import { ExpoNotificationService } from '../../services/expo-notification.service';
import { PushRelayService } from '../../services/push-relay.service';
import { CloudWorkerConfigModule } from '../../config/cloud-worker/config.module';
import { RedisConfigModule } from '../../config/database/redis/config.module';
import { isCloudMode } from '../../config/deployment-mode';
import { SenderKeysModule } from '../sender-keys/sender-keys.module';
import { MediaConfigModule } from '../../config/media/config.module';

/**
 * Conditional imports based on deployment mode
 * Redis is only needed in CLOUD mode for multi-instance Socket.IO
 */
const conditionalImports = isCloudMode() ? [RedisConfigModule] : [];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Room,
      RoomUser,
      User,
      PushToken,
      PendingMessage,
      MediaBlob,
    ]),
    SenderKeysModule,
    MediaConfigModule,
    CloudWorkerConfigModule,
    ...conditionalImports,
  ],
  providers: [
    ChatGateway,
    MessageService,
    RoomService,
    ExpoNotificationService,
    PushRelayService,
  ],
  controllers: [ChatController],
  exports: [MessageService, RoomService],
})
export class ChatModule {}
