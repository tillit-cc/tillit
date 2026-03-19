import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MediaConfigService {
  constructor(private configService: ConfigService) {}

  /**
   * Directory where media blobs are stored
   * Default: ./data/media
   */
  get storageDir(): string {
    return this.configService.get<string>('media.storageDir') ?? './data/media';
  }

  /**
   * Maximum file size in bytes
   * Default: 10MB
   */
  get maxSize(): number {
    return (
      Number(this.configService.get<number>('media.maxSize')) ||
      10 * 1024 * 1024
    );
  }

  /**
   * Number of days to retain media before cleanup
   * Default: 30 days
   */
  get retentionDays(): number {
    return Number(this.configService.get<number>('media.retentionDays')) || 30;
  }

  /**
   * Retention period in milliseconds
   */
  get retentionMs(): number {
    return this.retentionDays * 24 * 60 * 60 * 1000;
  }
}
