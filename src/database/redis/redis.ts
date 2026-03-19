import IORedis, { Redis, RedisKey } from 'ioredis';
import { RedisConfigService } from '../../config/database/redis/config.service';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class RedisKeystore {
  private readonly logger = new Logger(RedisKeystore.name);
  private _redis: Redis;

  constructor(redisConfig: RedisConfigService) {
    this._redis = new IORedis({
      host: redisConfig.host,
      port: redisConfig.port,
      db: redisConfig.db,
      username: redisConfig.user,
      password: redisConfig.password,
      keyPrefix: redisConfig.keyPrefix,
    });
  }

  public async keys(key: string): Promise<string[] | void> {
    return this._redis.keys(key).catch((err) => this.logger.error(err));
  }

  public async get(key: RedisKey): Promise<string | void | null> {
    return this._redis.get(key).catch((err) => this.logger.error(err));
  }

  public async jsonGet(key: RedisKey): Promise<string | null> {
    const res = await this._redis
      .call('JSON.GET', key)
      .catch((err) => this.logger.error(err));
    if (!res) {
      return null;
    }
    return res as string;
  }

  public async set(key: RedisKey, data: string, ttl = 0): Promise<void> {
    await this._redis
      .set(key, data, 'EX', ttl)
      .catch((err) => this.logger.error(err));
  }

  public jsonSet(key: RedisKey, data: string, ttl?: number): void {
    this._redis
      .call('JSON.SET', key, '$', data)
      .catch((err) => this.logger.error(err));
    if (ttl) {
      this._redis.expire(key, ttl).catch((err) => this.logger.error(err));
    }
  }

  public async getdel(key: RedisKey): Promise<string | null> {
    return this._redis.getdel(key).catch((err) => {
      this.logger.error(err);
      return null;
    });
  }

  public del(key: RedisKey): void {
    this._redis.del(key).catch((err) => this.logger.error(err));
  }
}
