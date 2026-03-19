import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from './configuration';
import { MariadbConfigService } from './config.service';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validationSchema: Joi.object({
        DB_HOST: Joi.string().default('localhost'),
        DB_PORT: Joi.number().default(3306),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().default('root'),
        DB_PASSWORD: Joi.string().allow('').default(''),
      }),
    }),
  ],
  providers: [ConfigService, MariadbConfigService],
  exports: [ConfigService, MariadbConfigService],
})
export class MariadbConfigModule {}
