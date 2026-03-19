import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SignalKey } from '../../entities/signal-key.entity';
import { SignalKeyType } from '../../entities/signal-key-type.entity';
import { User } from '../../entities/user.entity';
import { UserDevice } from '../../entities/user-device.entity';
import { KeysService } from './services/keys.service';
import { KeysController } from './controllers/keys.controller';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SignalKey, SignalKeyType, User, UserDevice]),
    ChatModule,
  ],
  providers: [KeysService],
  controllers: [KeysController],
  exports: [KeysService],
})
export class KeysModule {}
