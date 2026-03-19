import { registerAs } from '@nestjs/config';

export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  db: process.env.REDIS_DB,
  user: process.env.REDIS_USER,
  password: process.env.REDIS_PASSWORD,
  keyPrefix: process.env.REDIS_KEY_PREFIX,
}));
