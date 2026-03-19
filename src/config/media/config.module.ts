import { Module } from '@nestjs/common';
import configuration from './configuration';
import { MediaConfigService } from './config.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forFeature(configuration)],
  providers: [ConfigService, MediaConfigService],
  exports: [ConfigService, MediaConfigService],
})
export class MediaConfigModule {}
