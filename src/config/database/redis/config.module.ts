import * as Joi from 'joi';
import { Module } from '@nestjs/common';
import configuration from './configuration';
import { RedisConfigService } from './config.service';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Import and provide timer configuration related classes.
 *
 * @module
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validationSchema: Joi.object({
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        REDIS_DB: Joi.number().default(0),
        REDIS_USER: Joi.string().default(''),
        REDIS_PASSWORD: Joi.string().default(''),
        REDIS_KEY_PREFIX: Joi.string().default(''),
      }),
    }),
  ],
  providers: [ConfigService, RedisConfigService],
  exports: [ConfigService, RedisConfigService],
})
export class RedisConfigModule {}
