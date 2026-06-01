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
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { KeysService } from '../services/keys.service';
import { RoomService } from '../../chat/services/room.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { AllowRecoveryScope } from '../../../auth/decorators/allow-recovery-scope.decorator';
import { RECOVERY_SCOPE } from '../../../common/types/authenticated-request';
import { PRIMARY_DEVICE_ID } from '../../../auth/dto/device-link.dto';
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
   * Upload Signal Protocol keys.
   *
   * Two acceptable JWT scopes:
   * - normal access token → full bundle upload, optional TOFU bind of the
   *   device-auth public key, optional `recoverPrimary` (when the caller
   *   already has full access — e.g. a primary that still controls its
   *   auth key but wants to wipe linked devices).
   * - recovery-scoped token → ONLY the primary-recovery shape is allowed:
   *   `{ deviceId: 1, recoverPrimary: true, deviceAuthPublicKey: <new> }`.
   *   Every other field is permitted (the new bundle accompanies the
   *   rotation), but the three above are mandatory.
   */
  @AllowRecoveryScope()
  @Post()
  async uploadKeys(
    @Request() req: AuthenticatedRequest,
    @Body() uploadKeysDto: UploadKeysDto,
  ) {
    if (req.user.scope === RECOVERY_SCOPE) {
      const recoveryShapeOk =
        uploadKeysDto.recoverPrimary === true &&
        uploadKeysDto.deviceId === PRIMARY_DEVICE_ID &&
        typeof uploadKeysDto.deviceAuthPublicKey === 'string' &&
        uploadKeysDto.deviceAuthPublicKey.length > 0;
      if (!recoveryShapeOk) {
        throw new BadRequestException(
          'Recovery token requires { deviceId: 1, recoverPrimary: true, deviceAuthPublicKey }',
          'RECOVERY_PAYLOAD_REQUIRED',
        );
      }
    }

    await this.keysService.uploadKeys(
      req.user.userId,
      uploadKeysDto.deviceId,
      uploadKeysDto.identityPublicKey,
      uploadKeysDto.registrationId,
      uploadKeysDto.signedPreKey,
      uploadKeysDto.preKeys,
      uploadKeysDto.kyberPreKeys,
      uploadKeysDto.deviceAuthPublicKey,
      uploadKeysDto.recoverPrimary,
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
   *
   * Multi-device aware bundle endpoint. Returns one bundle per active device
   * under `devices: [...]`. Backward-compat fields at the top level mirror
   * the first device's bundle so legacy single-device clients (which read
   * `signedPreKey`/`preKey`/`kyberPreKey` directly) keep working without
   * needing an immediate upgrade. Once every consumer reads `devices[]`
   * those top-level fields can be retired.
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

    const { devices } =
      await this.keysService.getAvailableKeysForUserDevices(targetUserId);

    const head = devices[0] ?? null;
    return {
      userId: targetUserId,
      // Top-level fields preserved for v0.x clients — they read the first
      // device. Multi-device-aware clients consume `devices[]` instead.
      // `deviceName`/`name` deliberately omitted — ADR-0001 P-2 forbids
      // leaking device names to peers.
      deviceId: head?.deviceId ?? null,
      registrationId: head?.registrationId ?? null,
      identityPublicKey: head?.identityKey ?? null,
      signedPreKey: head?.signedPreKey ?? null,
      preKey: head?.preKey ?? null,
      kyberPreKey: head?.kyberPreKey ?? null,
      devices,
    };
  }
}
