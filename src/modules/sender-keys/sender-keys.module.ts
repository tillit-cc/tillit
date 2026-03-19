import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SenderKeysController } from './controllers/sender-keys.controller';
import { SenderKeysService } from './services/sender-keys.service';
import { SenderKeyDistribution } from '../../entities/sender-key-distribution.entity';
import { SenderKeyMetadata } from '../../entities/sender-key-metadata.entity';
import { Room } from '../../entities/room.entity';
import { RoomUser } from '../../entities/room-user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SenderKeyDistribution,
      SenderKeyMetadata,
      Room,
      RoomUser,
    ]),
  ],
  controllers: [SenderKeysController],
  providers: [SenderKeysService],
  exports: [SenderKeysService],
})
export class SenderKeysModule {}
