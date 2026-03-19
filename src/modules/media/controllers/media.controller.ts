import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  Response,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response as ExpressResponse } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { MediaService } from '../services/media.service';
import { UploadMediaDto } from '../dto/upload-media.dto';
import { RoomService } from '../../chat/services/room.service';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly roomService: RoomService,
  ) {}

  /**
   * POST /media
   * Upload encrypted media blob
   * Body: { roomId, data (base64), mimeType }
   */
  @Post()
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_MEDIA_LIMIT || '10', 10),
    },
  })
  async upload(
    @Request() req: AuthenticatedRequest,
    @Body() uploadDto: UploadMediaDto,
  ) {
    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      uploadDto.roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    // Strip ephemeral fields — use POST /media/ephemeral instead
    uploadDto.ephemeral = false;
    delete uploadDto.ttlHours;

    try {
      const result = await this.mediaService.upload(req.user.userId, uploadDto);

      return {
        success: true,
        mediaId: result.id,
        size: result.size,
        expiresAt: result.expiresAt,
      };
    } catch (error) {
      this.logger.error(
        `Upload failed for user ${req.user.userId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Media upload failed');
    }
  }

  /**
   * POST /media/ephemeral
   * Upload ephemeral encrypted media blob (auto-deletes after download or TTL)
   * Body: { roomId, data (base64), mimeType, ttlHours? }
   */
  @Post('ephemeral')
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_MEDIA_LIMIT || '10', 10),
    },
  })
  async uploadEphemeral(
    @Request() req: AuthenticatedRequest,
    @Body() uploadDto: UploadMediaDto,
  ) {
    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      uploadDto.roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    // Force ephemeral mode
    uploadDto.ephemeral = true;

    try {
      const result = await this.mediaService.upload(req.user.userId, uploadDto);

      return {
        success: true,
        mediaId: result.id,
        size: result.size,
        expiresAt: result.expiresAt,
      };
    } catch (error) {
      this.logger.error(
        `Ephemeral upload failed for user ${req.user.userId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Ephemeral media upload failed');
    }
  }

  /**
   * GET /media/:id
   * Download encrypted media blob
   */
  @Get(':id')
  async download(
    @Param('id', ParseUUIDPipe) mediaId: string,
    @Request() req: AuthenticatedRequest,
    @Response() res: ExpressResponse,
  ) {
    const info = await this.mediaService.getInfo(mediaId);
    if (!info) {
      throw new NotFoundException('Media not found');
    }

    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      info.roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const { data } = await this.mediaService.download(mediaId, req.user.userId);

    // Always serve as opaque binary — blobs are encrypted client-side
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${mediaId}.enc"`,
    });

    res.send(data);
  }

  /**
   * GET /media/:id/info
   * Get media metadata without downloading
   */
  @Get(':id/info')
  async getInfo(
    @Param('id', ParseUUIDPipe) mediaId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const info = await this.mediaService.getInfo(mediaId);
    if (!info) {
      throw new NotFoundException('Media not found');
    }

    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      info.roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    return info;
  }

  /**
   * POST /media/:id/viewed
   * Mark ephemeral media as viewed — deletes it immediately
   * Idempotent: returns 200 even if already deleted
   */
  @Post(':id/viewed')
  async markViewed(
    @Param('id', ParseUUIDPipe) mediaId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const info = await this.mediaService.getInfo(mediaId);

    // If media doesn't exist, return success (idempotent)
    if (!info) {
      return { success: true };
    }

    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      info.roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    await this.mediaService.markViewed(mediaId);

    return { success: true };
  }

  /**
   * DELETE /media/:id
   * Delete media blob (only uploader can delete)
   */
  @Delete(':id')
  async delete(
    @Param('id', ParseUUIDPipe) mediaId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const info = await this.mediaService.getInfo(mediaId);
    if (!info) {
      throw new NotFoundException('Media not found');
    }

    // Only uploader can delete
    if (info.uploaderId !== req.user.userId) {
      throw new ForbiddenException('Only the uploader can delete this media');
    }

    await this.mediaService.delete(mediaId);

    return { success: true };
  }
}
