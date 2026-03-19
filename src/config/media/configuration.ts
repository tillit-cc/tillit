import { registerAs } from '@nestjs/config';

export default registerAs('media', () => ({
  storageDir: process.env.MEDIA_STORAGE_DIR,
  maxSize: process.env.MEDIA_MAX_SIZE,
  retentionDays: process.env.MEDIA_RETENTION_DAYS,
}));
