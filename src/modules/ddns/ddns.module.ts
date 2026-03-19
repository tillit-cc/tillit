import { Module } from '@nestjs/common';
import { CloudWorkerConfigModule } from '../../config/cloud-worker/config.module';
import { DdnsService } from './ddns.service';

@Module({
  imports: [CloudWorkerConfigModule],
  providers: [DdnsService],
  exports: [DdnsService],
})
export class DdnsModule {}
