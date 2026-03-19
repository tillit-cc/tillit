import {
  Injectable,
  Logger,
  NotFoundException,
  GoneException,
  ForbiddenException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { MediaBlob } from '../../../entities/media-blob.entity';
import { MediaDownload } from '../../../entities/media-download.entity';
import { RoomUser } from '../../../entities/room-user.entity';
import { MediaConfigService } from '../../../config/media/config.service';
import { UploadMediaDto } from '../dto/upload-media.dto';

export interface MediaBlobInfo {
  id: string;
  roomId: number;
  uploaderId: number;
  mimeType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  ephemeral: boolean;
  maxDownloads: number | null;
  downloadCount: number;
}

@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaService.name);
  private cleanupInterval: NodeJS.Timeout;

  constructor(
    @InjectRepository(MediaBlob)
    private mediaBlobRepository: Repository<MediaBlob>,
    @InjectRepository(MediaDownload)
    private mediaDownloadRepository: Repository<MediaDownload>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
    private mediaConfig: MediaConfigService,
    private dataSource: DataSource,
  ) {}

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  async onModuleInit() {
    // Ensure storage directory exists
    await this.ensureStorageDir();

    // Schedule cleanup of expired media
    this.scheduleCleanup();
  }

  /**
   * Ensure the storage directory exists
   */
  private async ensureStorageDir(): Promise<void> {
    const dir = this.mediaConfig.storageDir;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      this.logger.log(`Media storage directory ready: ${dir}`);
    } catch (error) {
      this.logger.error(`Failed to create storage directory: ${error}`);
      throw error;
    }
  }

  /**
   * Upload encrypted media blob
   * Data is already encrypted client-side, we just store it
   */
  async upload(
    uploaderId: number,
    dto: UploadMediaDto,
  ): Promise<MediaBlobInfo> {
    const { roomId, data, mimeType } = dto;

    // Decode base64 data
    const buffer = Buffer.from(data, 'base64');
    const size = buffer.length;

    // Check size limit
    if (size > this.mediaConfig.maxSize) {
      throw new Error(
        `File too large: ${size} bytes (max: ${this.mediaConfig.maxSize} bytes)`,
      );
    }

    // Generate unique ID and file path
    const id = uuidv4();
    const fileName = `${id}.enc`;
    const filePath = path.join(this.mediaConfig.storageDir, fileName);

    // Write encrypted data to filesystem
    await fs.promises.writeFile(filePath, buffer);

    const now = Date.now();

    // Ephemeral media configuration
    let expiresAt: number;
    let maxDownloads: number | null = null;
    const ephemeral = dto.ephemeral === true;

    if (ephemeral) {
      const defaultTtl = parseInt(
        process.env.EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS || '24',
        10,
      );
      const maxTtl = parseInt(
        process.env.EPHEMERAL_MEDIA_MAX_TTL_HOURS || '168',
        10,
      );
      const ttlHours = Math.min(dto.ttlHours || defaultTtl, maxTtl);
      expiresAt = now + ttlHours * 3600000;
      // maxDownloads = room member count - 1 (sender doesn't download)
      const memberCount = await this.roomUserRepository.count({
        where: { roomId },
      });
      maxDownloads = Math.max(memberCount - 1, 1);
    } else {
      expiresAt = now + this.mediaConfig.retentionMs;
    }

    // Save metadata to database
    const mediaBlob = this.mediaBlobRepository.create({
      id,
      roomId,
      uploaderId,
      filePath: fileName, // Store relative path
      mimeType,
      size,
      createdAt: now,
      expiresAt,
      ephemeral,
      maxDownloads,
      downloadCount: 0,
    });

    await this.mediaBlobRepository.save(mediaBlob);

    this.logger.log(
      `Uploaded ${ephemeral ? 'ephemeral ' : ''}media ${id} (${size} bytes) for room ${roomId}`,
    );

    return {
      id,
      roomId,
      uploaderId,
      mimeType,
      size,
      createdAt: now,
      expiresAt,
      ephemeral,
      maxDownloads,
      downloadCount: 0,
    };
  }

  /**
   * Download encrypted media blob
   * Returns the raw encrypted data
   * For ephemeral media, tracks per-user downloads and auto-deletes
   */
  async download(
    mediaId: string,
    userId: number,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const mediaBlob = await this.mediaBlobRepository.findOne({
      where: { id: mediaId },
    });

    if (!mediaBlob) {
      throw new NotFoundException(`Media ${mediaId} not found`);
    }

    // Check if expired
    if (Date.now() > mediaBlob.expiresAt) {
      // Clean up expired blob
      await this.delete(mediaId);
      throw new GoneException(`Media ${mediaId} has expired`);
    }

    const filePath = this.resolveStoragePath(mediaBlob.filePath);

    // Read encrypted data from filesystem
    const data = await fs.promises.readFile(filePath);

    // Atomic ephemeral download tracking inside a transaction
    if (mediaBlob.ephemeral) {
      // Reject users who joined the room after the media was uploaded
      const membership = await this.roomUserRepository.findOne({
        where: { roomId: mediaBlob.roomId, userId },
      });
      if (membership) {
        const joinedAtMs = Number(membership.joinedAt);
        const createdAtMs = Number(mediaBlob.createdAt);
        this.logger.debug(
          `Ephemeral check: user ${userId} joinedAt=${joinedAtMs} createdAt=${createdAtMs} diff=${joinedAtMs - createdAtMs}ms`,
        );
        if (joinedAtMs > createdAtMs) {
          throw new ForbiddenException(
            'Media was uploaded before you joined this room',
          );
        }
      }

      let newCount = 0;

      try {
        await this.dataSource.transaction(async (manager) => {
          // Insert download record — unique constraint (mediaId, userId)
          // prevents duplicate downloads atomically
          await manager
            .createQueryBuilder()
            .insert()
            .into(MediaDownload)
            .values({ mediaId, userId, downloadedAt: Date.now() })
            .execute();

          // Atomic increment of download_count
          await manager
            .createQueryBuilder()
            .update(MediaBlob)
            .set({ downloadCount: () => 'download_count + 1' })
            .where('id = :id', { id: mediaId })
            .execute();

          // Read back the updated count
          const updated = await manager.findOne(MediaBlob, {
            where: { id: mediaId },
          });
          newCount = updated?.downloadCount ?? 0;
        });
      } catch (error) {
        // Unique constraint violation = user already downloaded
        if (
          error.code === 'ER_DUP_ENTRY' || // MariaDB
          error.code === 'SQLITE_CONSTRAINT' || // SQLite
          (error.message && error.message.includes('UNIQUE'))
        ) {
          throw new GoneException('Media already downloaded');
        }
        throw error;
      }

      // Auto-delete if all members have downloaded (outside transaction)
      if (
        mediaBlob.maxDownloads !== null &&
        newCount >= mediaBlob.maxDownloads
      ) {
        this.logger.log(
          `Ephemeral media ${mediaId} fully downloaded, deleting`,
        );
        await this.delete(mediaId);
      }
    }

    return {
      data,
      mimeType: mediaBlob.mimeType,
    };
  }

  /**
   * Mark ephemeral media as viewed — deletes it immediately
   * Only works on ephemeral media. Idempotent if already deleted.
   */
  async markViewed(mediaId: string): Promise<void> {
    const mediaBlob = await this.mediaBlobRepository.findOne({
      where: { id: mediaId },
    });

    if (!mediaBlob) {
      return; // Already deleted, idempotent
    }

    if (!mediaBlob.ephemeral) {
      return; // Only ephemeral media can be marked as viewed
    }

    await this.delete(mediaId);
    this.logger.log(`Ephemeral media ${mediaId} marked as viewed, deleted`);
  }

  /**
   * Get media info without downloading
   */
  async getInfo(mediaId: string): Promise<MediaBlobInfo | null> {
    const mediaBlob = await this.mediaBlobRepository.findOne({
      where: { id: mediaId },
    });

    if (!mediaBlob) {
      return null;
    }

    return {
      id: mediaBlob.id,
      roomId: mediaBlob.roomId,
      uploaderId: mediaBlob.uploaderId,
      mimeType: mediaBlob.mimeType,
      size: mediaBlob.size,
      createdAt: mediaBlob.createdAt,
      expiresAt: mediaBlob.expiresAt,
      ephemeral: mediaBlob.ephemeral,
      maxDownloads: mediaBlob.maxDownloads,
      downloadCount: mediaBlob.downloadCount,
    };
  }

  /**
   * Delete a media blob (used by owner or room cleanup)
   */
  async delete(mediaId: string): Promise<void> {
    const mediaBlob = await this.mediaBlobRepository.findOne({
      where: { id: mediaId },
    });

    if (!mediaBlob) {
      return;
    }

    // Delete file from filesystem
    const filePath = this.resolveStoragePath(mediaBlob.filePath);

    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      this.logger.warn(
        `Failed to delete file ${mediaBlob.id}: ${error.message}`,
      );
    }

    // Delete from database (cascade deletes media_downloads)
    await this.mediaBlobRepository.delete({ id: mediaId });

    this.logger.debug(`Deleted media ${mediaId}`);
  }

  /**
   * Cleanup expired media blobs
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();

    // Find expired blobs
    const expiredBlobs = await this.mediaBlobRepository.find({
      where: { expiresAt: LessThan(now) },
    });

    if (expiredBlobs.length === 0) {
      return 0;
    }

    // Delete files and database records
    for (const blob of expiredBlobs) {
      await this.delete(blob.id);
    }

    this.logger.log(`Cleaned up ${expiredBlobs.length} expired media blobs`);

    return expiredBlobs.length;
  }

  /**
   * Resolve and validate a file path within the storage directory.
   * Prevents path traversal attacks by ensuring the resolved path
   * stays within the configured storage directory.
   */
  private resolveStoragePath(filePath: string): string {
    const storageDir = path.resolve(this.mediaConfig.storageDir);
    const resolved = path.resolve(storageDir, filePath);

    if (!resolved.startsWith(storageDir + path.sep)) {
      this.logger.error(`Path traversal attempt detected: ${filePath}`);
      throw new NotFoundException('Media not found');
    }

    return resolved;
  }

  /**
   * Schedule periodic cleanup of expired media
   */
  private scheduleCleanup(): void {
    const interval = parseInt(
      process.env.MEDIA_CLEANUP_INTERVAL_MS || '3600000',
      10,
    );

    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpired().catch((error) => {
        this.logger.error(`Media cleanup failed: ${String(error)}`);
      });
    }, interval);

    this.logger.log(`Media cleanup scheduled (every ${interval}ms)`);
  }
}
