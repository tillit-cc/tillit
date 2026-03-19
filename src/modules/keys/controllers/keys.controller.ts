import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  ParseIntPipe,
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { KeysService } from '../services/keys.service';
import { RoomService } from '../../chat/services/room.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { KeyFetchThrottleGuard } from '../guards/key-fetch-throttle.guard';
import { UploadKeysDto } from '../dto/keys.dto';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

@Controller('keys')
@UseGuards(JwtAuthGuard)
export class KeysController {
  constructor(
    private readonly keysService: KeysService,
    private readonly roomService: RoomService,
  ) {}

  /**
   * POST /keys
   * Upload Signal Protocol keys
   */
  @Post()
  async uploadKeys(
    @Request() req: AuthenticatedRequest,
    @Body() uploadKeysDto: UploadKeysDto,
  ) {
    await this.keysService.uploadKeys(
      req.user.userId,
      uploadKeysDto.deviceId,
      uploadKeysDto.identityPublicKey,
      uploadKeysDto.registrationId,
      uploadKeysDto.signedPreKey,
      uploadKeysDto.preKeys,
      uploadKeysDto.kyberPreKeys,
    );

    return {
      message: 'Keys uploaded successfully',
      preKeysCount: uploadKeysDto.preKeys?.length || 0,
      kyberPreKeysCount: uploadKeysDto.kyberPreKeys?.length || 0,
    };
  }

  /**
   * GET /keys/status/self
   * Get own key status
   */
  @Get('status/self')
  async getOwnKeyStatus(@Request() req: AuthenticatedRequest) {
    const status = await this.keysService.getKeyStatus(req.user.userId);

    return {
      userId: req.user.userId,
      ...status,
    };
  }

  /**
   * GET /keys/:id_user
   * Get and consume pre-keys for a specific user
   */
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_KEYS_LIMIT || '20', 10),
    },
  })
  @UseGuards(KeyFetchThrottleGuard)
  @Get(':id_user')
  async getKeysForUser(
    @Param('id_user', ParseIntPipe) targetUserId: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const sharesRoom = await this.roomService.usersShareRoom(
      req.user.userId,
      targetUserId,
    );
    if (!sharesRoom) {
      throw new ForbiddenException('Cannot fetch keys for this user');
    }

    const keys = await this.keysService.getAvailableKeysForUser(targetUserId);
    const deviceId = keys.userDevice?.deviceId ?? null;

    return {
      userId: targetUserId,
      deviceId,
      registrationId: keys.userDevice?.registrationId ?? null,
      identityPublicKey: keys.userDevice?.identityPublicKey ?? null,
      name: keys.userDevice?.name ?? null,
      signedPreKey: keys.signedPreKey
        ? {
            keyId: keys.signedPreKey.keyId,
            keyData: keys.signedPreKey.keyData,
            signature: keys.signedPreKey.keySignature,
            deviceId: Number(keys.signedPreKey.deviceId),
          }
        : null,
      preKey: keys.preKey
        ? {
            keyId: keys.preKey.keyId,
            keyData: keys.preKey.keyData,
            deviceId: Number(keys.preKey.deviceId),
          }
        : null,
      kyberPreKey: keys.kyberPreKey
        ? {
            keyId: keys.kyberPreKey.keyId,
            keyData: keys.kyberPreKey.keyData,
            signature: keys.kyberPreKey.keySignature,
            deviceId: Number(keys.kyberPreKey.deviceId),
          }
        : null,
    };
  }
}
