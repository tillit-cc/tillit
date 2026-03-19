import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BannedUser } from '../../entities/banned-user.entity';
import { BanService } from './ban.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([BannedUser])],
  providers: [BanService],
  exports: [BanService],
})
export class BanModule {}
