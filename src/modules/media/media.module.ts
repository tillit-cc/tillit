import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaBlob } from '../../entities/media-blob.entity';
import { MediaDownload } from '../../entities/media-download.entity';
import { RoomUser } from '../../entities/room-user.entity';
import { MediaConfigModule } from '../../config/media/config.module';
import { MediaService } from './services/media.service';
import { MediaController } from './controllers/media.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaBlob, MediaDownload, RoomUser]),
    MediaConfigModule,
    ChatModule, // For RoomService
  ],
  providers: [MediaService],
  controllers: [MediaController],
  exports: [MediaService],
})
export class MediaModule {}
