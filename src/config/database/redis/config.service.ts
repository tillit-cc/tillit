import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Service dealing with timer config based operations.
 *
 * @class
 */
@Injectable()
export class RedisConfigService {
  constructor(private configService: ConfigService) {}

  get host(): string {
    return this.configService.get<string>('redis.host') ?? '';
  }
  get port(): number {
    return Number(this.configService.get<number>('redis.port'));
  }
  get db(): number {
    return Number(this.configService.get<number>('redis.db'));
  }
  get user(): string {
    return this.configService.get<string>('redis.user') ?? '';
  }
  get password(): string {
    return this.configService.get<string>('redis.password') ?? '';
  }
  get keyPrefix(): string {
    return this.configService.get<string>('redis.keyPrefix') ?? '';
  }
}
