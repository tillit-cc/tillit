import { Module } from '@nestjs/common';
import configuration from './configuration';
import { CloudWorkerConfigService } from './config.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forFeature(configuration)],
  providers: [ConfigService, CloudWorkerConfigService],
  exports: [ConfigService, CloudWorkerConfigService],
})
export class CloudWorkerConfigModule {}
