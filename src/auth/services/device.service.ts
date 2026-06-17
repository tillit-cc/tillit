import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  UserDevice,
  UserDeviceStatus,
} from '../../entities/user-device.entity';
import { SignalKey } from '../../entities/signal-key.entity';
import { DeviceLinkNotifier, DeviceLinkService } from './device-link.service';
import {
  DeviceListResponse,
  DeviceRevokeResponse,
  DeviceSummaryDto,
  PRIMARY_DEVICE_ID,
} from '../dto/device-link.dto';

class PrimaryRequiredException extends ForbiddenException {
  constructor() {
    super({ statusCode: HttpStatus.FORBIDDEN, error: 'PRIMARY_REQUIRED' });
  }
}

class CannotRevokePrimaryException extends BadRequestException {
  constructor() {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'CANNOT_REVOKE_PRIMARY',
    });
  }
}

class AlreadyRevokedException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, error: 'ALREADY_REVOKED' });
  }
}

class DeviceNotFoundException extends NotFoundException {
  constructor() {
    super({
      statusCode: HttpStatus.NOT_FOUND,
      error: 'DEVICE_NOT_FOUND',
    });
  }
}

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  private notifier?: DeviceLinkNotifier;

  constructor(
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(SignalKey)
    private readonly signalKeyRepo: Repository<SignalKey>,
    private readonly deviceLinkService: DeviceLinkService,
  ) {}

  setNotifier(notifier: DeviceLinkNotifier): void {
    this.notifier = notifier;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /auth/devices
  // ──────────────────────────────────────────────────────────────────────────

  async listDevices(
    userId: number,
    currentDeviceId: number,
  ): Promise<DeviceListResponse> {
    if (currentDeviceId !== PRIMARY_DEVICE_ID) {
      throw new PrimaryRequiredException();
    }

    const devices = await this.deviceRepo.find({
      where: { userId },
      order: { deviceId: 'ASC' },
    });

    // Hide revoked rows older than 30 days — keep recent ones for audit
    // (consistent with the API spec).
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const visible = devices.filter((d) => {
      if (d.status !== UserDeviceStatus.REVOKED) return true;
      const revokedAt = d.revokedAt ? Number(d.revokedAt) : 0;
      return revokedAt >= cutoff;
    });

    const summaries: DeviceSummaryDto[] = visible.map((d) =>
      this.toSummary(d, currentDeviceId),
    );
    return { devices: summaries };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /auth/devices/:id
  // ──────────────────────────────────────────────────────────────────────────

  async revokeDevice(
    primaryUserId: number,
    primaryDeviceId: number,
    targetDeviceId: number,
  ): Promise<DeviceRevokeResponse> {
    if (primaryDeviceId !== PRIMARY_DEVICE_ID) {
      throw new PrimaryRequiredException();
    }
    if (targetDeviceId === PRIMARY_DEVICE_ID) {
      throw new CannotRevokePrimaryException();
    }

    const device = await this.deviceRepo.findOne({
      where: { userId: primaryUserId, deviceId: targetDeviceId },
    });
    if (!device) throw new DeviceNotFoundException();
    if (device.status === UserDeviceStatus.REVOKED) {
      throw new AlreadyRevokedException();
    }

    return this.revokeInternal(device, false);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /auth/devices/me
  // ──────────────────────────────────────────────────────────────────────────

  async revokeSelf(
    userId: number,
    deviceId: number,
  ): Promise<DeviceRevokeResponse> {
    if (deviceId === PRIMARY_DEVICE_ID) {
      // Primary self-logout is account deletion territory — keep it out of
      // this endpoint. The dedicated DELETE /auth/account already handles it.
      throw new CannotRevokePrimaryException();
    }

    const device = await this.deviceRepo.findOne({
      where: { userId, deviceId },
    });
    if (!device) throw new DeviceNotFoundException();
    if (device.status === UserDeviceStatus.REVOKED) {
      throw new AlreadyRevokedException();
    }

    return this.revokeInternal(device, true);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Primary recovery (ADR-0010 OQ-1)
  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  private async revokeInternal(
    device: UserDevice,
    isSelf: boolean,
  ): Promise<DeviceRevokeResponse> {
    const revokedAtMs = Date.now();
    device.status = UserDeviceStatus.REVOKED;
    device.revokedAt = revokedAtMs;
    await this.deviceRepo.save(device);

    // Make the revocation effective immediately on this instance's JWT/socket
    // revocation check, ahead of the cache's TTL refresh.
    this.deviceLinkService.markDeviceRevokedInCache(
      device.userId,
      device.deviceId,
    );

    // Drop the pre-keys / signed pre-key / kyber keys for this device so
    // GET /keys/:userId stops returning them and no new sessions can be
    // established with the revoked device.
    await this.signalKeyRepo.delete({
      userId: device.userId,
      deviceId: String(device.deviceId),
    });

    if (this.notifier) {
      const isoAt = new Date(revokedAtMs).toISOString();
      try {
        if (!isSelf) {
          // Notify the device itself FIRST so it can do local cleanup
          // before the socket is forcibly disconnected.
          await this.notifier.notifyDeviceItselfRevoked(
            device.userId,
            device.deviceId,
            isoAt,
          );
        }
        await this.notifier.notifyPeersDeviceRevoked(
          device.userId,
          device.deviceId,
          isoAt,
        );
        await this.notifier.disconnectDeviceSockets(
          device.userId,
          device.deviceId,
        );
      } catch (err) {
        this.logger.error(
          `Failed to broadcast deviceRevoked for user ${device.userId} device ${device.deviceId}`,
          err as Error,
        );
      }
    }

    return {
      deviceId: device.deviceId,
      status: 'revoked',
      revokedAt: new Date(revokedAtMs).toISOString(),
    };
  }

  private toSummary(
    device: UserDevice,
    currentDeviceId: number,
  ): DeviceSummaryDto {
    return {
      deviceId: device.deviceId,
      deviceName:
        device.deviceName ||
        device.name ||
        (device.deviceId === PRIMARY_DEVICE_ID
          ? 'Primary device'
          : `Device ${device.deviceId}`),
      status: device.status,
      isPrimary: device.deviceId === PRIMARY_DEVICE_ID,
      isCurrent: device.deviceId === currentDeviceId,
      createdAt: device.createdAt.toISOString(),
      lastSeen: device.lastActiveAt ? device.lastActiveAt.toISOString() : null,
      userAgent: device.userAgent ?? null,
    };
  }
}
