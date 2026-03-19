import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration from './configuration';
import { JwtConfigService } from './config.service';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validationSchema: Joi.object({
        JWT_ALGORITHM: Joi.string().default('RS256'),
        PUBLIC_KEY_PATH: Joi.string().default('./keys/public.pem'),
        PRIVATE_KEY_PATH: Joi.string().default('./keys/private.pem'),
        JWT_EXPIRES_IN: Joi.string().default('7d'),
      }),
    }),
  ],
  providers: [ConfigService, JwtConfigService],
  exports: [ConfigService, JwtConfigService],
})
export class JwtConfigModule {}
