import {
  Injectable,
  Logger,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Buffer } from 'buffer';
import {
  DeviceLinkSession,
  DeviceLinkSessionStatus,
} from '../../entities/device-link-session.entity';
import {
  UserDevice,
  UserDeviceStatus,
} from '../../entities/user-device.entity';
import { SignalKey } from '../../entities/signal-key.entity';
import { User } from '../../entities/user.entity';
import {
  CompleteLinkDto,
  DEFAULT_DEVICE_CAP,
  DEFAULT_LINK_TTL_MS,
  DEFAULT_OPEN_SESSION_CAP,
  InitLinkDto,
  LinkCompleteResponse,
  LinkInitResponse,
  LinkResultResponse,
  LinkSharePubkeyResponse,
  PRIMARY_DEVICE_ID,
  SharePubkeyDto,
} from '../dto/device-link.dto';

/**
 * Domain errors → HTTP status codes documented in
 * `_shared/api/multi-device-linking.md`. We surface a stable `error` code in
 * the JSON body alongside the message so the client doesn't have to grep
 * human strings.
 */
class SessionNotFoundException extends HttpException {
  constructor() {
    super(
      { statusCode: HttpStatus.NOT_FOUND, error: 'SESSION_NOT_FOUND' },
      HttpStatus.NOT_FOUND,
    );
  }
}

class SessionExpiredException extends GoneException {
  constructor(code = 'SESSION_EXPIRED') {
    super({ statusCode: HttpStatus.GONE, error: code });
  }
}

class SessionNotWaitingException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, error: 'SESSION_NOT_WAITING' });
  }
}

class SessionNotPubkeySharedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'SESSION_NOT_PUBKEY_SHARED',
    });
  }
}

class PubkeyMismatchException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, error: 'PUBKEY_MISMATCH' });
  }
}

class PrimaryIdentityNotPublishedException extends ConflictException {
  constructor() {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'PRIMARY_IDENTITY_NOT_PUBLISHED',
    });
  }
}

class SessionAlreadyConsumedException extends GoneException {
  constructor() {
    super({ statusCode: HttpStatus.GONE, error: 'SESSION_ALREADY_CONSUMED' });
  }
}

class DeviceLimitReachedException extends ConflictException {
  constructor() {
    super({ statusCode: HttpStatus.CONFLICT, error: 'DEVICE_LIMIT_REACHED' });
  }
}

class TooManyLinksException extends HttpException {
  constructor() {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, error: 'TOO_MANY_LINKS' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

class PrimaryRequiredException extends ForbiddenException {
  constructor() {
    super({ statusCode: HttpStatus.FORBIDDEN, error: 'PRIMARY_REQUIRED' });
  }
}

class InvalidEphemeralKeyException extends BadRequestException {
  constructor() {
    super({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'INVALID_EPHEMERAL_KEY',
    });
  }
}

class PayloadTooLargeException extends BadRequestException {
  constructor() {
    super({ statusCode: HttpStatus.BAD_REQUEST, error: 'PAYLOAD_TOO_LARGE' });
  }
}

@Injectable()
export class DeviceLinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceLinkService.name);
  private cleanupInterval?: NodeJS.Timeout;

  // Hook used by the chat gateway to broadcast deviceLinked/deviceRevoked
  // to peers and to the device's own sockets — wired up at module init time
  // to avoid a circular dependency.
  private notifier?: DeviceLinkNotifier;

  constructor(
    @InjectRepository(DeviceLinkSession)
    private readonly sessionRepo: Repository<DeviceLinkSession>,
    @InjectRepository(UserDevice)
    private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(SignalKey)
    private readonly signalKeyRepo: Repository<SignalKey>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  setNotifier(notifier: DeviceLinkNotifier): void {
    this.notifier = notifier;
  }

  onModuleInit(): void {
    const interval = parseInt(
      process.env.DEVICE_LINK_CLEANUP_INTERVAL_MS || '60000',
      10,
    );
    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredSessions().catch((err) =>
        this.logger.error('Session cleanup failed', err as Error),
      );
    }, interval);
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/init  (anonymous — the new device starts here)
  // ──────────────────────────────────────────────────────────────────────────

  async initLink(dto: InitLinkDto): Promise<LinkInitResponse> {
    this.assertEphemeralKey(dto.ephemeralPublicKey);

    // Global soft cap on open `waiting` sessions: protects the anonymous
    // endpoint from flooding. The per-IP Throttler at the controller layer
    // covers the volumetric side; this cap covers the absolute total.
    const openCap = this.openSessionCap();
    const nowMs = Date.now();
    const openCount = await this.sessionRepo
      .createQueryBuilder('s')
      .where('s.status = :waiting', {
        waiting: DeviceLinkSessionStatus.WAITING,
      })
      .andWhere('s.expires_at > :now', { now: nowMs })
      .getCount();
    if (openCount >= openCap) {
      throw new TooManyLinksException();
    }

    const sessionId = base64url(crypto.randomBytes(32));
    const ttlMs = this.linkTtlMs();
    const expiresAtMs = nowMs + ttlMs;

    const row = this.sessionRepo.create({
      sessionId,
      ephemeralPublicKey: dto.ephemeralPublicKey,
      deviceName: dto.deviceName ?? null,
      userAgent: dto.userAgent ?? null,
      status: DeviceLinkSessionStatus.WAITING,
      createdAt: nowMs,
      expiresAt: expiresAtMs,
    });
    await this.sessionRepo.save(row);

    return {
      sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/share-pubkey  (primary JWT)
  //
  // wire v2.1 — the primary publishes `P_pub` ahead of `/complete` so the new
  // device can compute the symmetric safety number before any commit. ADR
  // `_shared/decisions/0004-symmetric-safety-number.md`. Idempotent for the
  // same `P_pub` (no-op on re-call); 409 PUBKEY_MISMATCH otherwise.
  // ──────────────────────────────────────────────────────────────────────────

  async sharePubkey(
    primaryUserId: number,
    primaryDeviceId: number,
    dto: SharePubkeyDto,
  ): Promise<LinkSharePubkeyResponse> {
    if (primaryDeviceId !== PRIMARY_DEVICE_ID) {
      throw new PrimaryRequiredException();
    }
    this.assertEphemeralKey(dto.primaryEphemeralPublicKey);

    return this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(DeviceLinkSession);

      const row = await sessionRepo.findOne({
        where: { sessionId: dto.sessionId },
      });
      if (!row) throw new SessionNotFoundException();
      this.assertNotExpired(row);

      // Idempotent: same primary, same P_pub → no-op. Different P_pub on the
      // same session → 409 to prevent an attacker forking a session.
      if (row.status === DeviceLinkSessionStatus.PUBKEY_SHARED) {
        if (row.primaryUserId !== primaryUserId) {
          throw new PubkeyMismatchException();
        }
        if (row.primaryEphemeralPubKey !== dto.primaryEphemeralPublicKey) {
          throw new PubkeyMismatchException();
        }
        return { ok: true };
      }
      if (row.status !== DeviceLinkSessionStatus.WAITING) {
        throw new SessionNotWaitingException();
      }

      row.primaryUserId = primaryUserId;
      row.primaryDeviceId = primaryDeviceId;
      row.primaryEphemeralPubKey = dto.primaryEphemeralPublicKey;
      row.status = DeviceLinkSessionStatus.PUBKEY_SHARED;
      await sessionRepo.save(row);

      return { ok: true };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/complete  (primary JWT)
  // ──────────────────────────────────────────────────────────────────────────

  async completeLink(
    primaryUserId: number,
    primaryDeviceId: number,
    dto: CompleteLinkDto,
  ): Promise<LinkCompleteResponse> {
    if (primaryDeviceId !== PRIMARY_DEVICE_ID) {
      throw new PrimaryRequiredException();
    }

    // 4 KB hard cap on the encrypted payload (spec). The base64 form can be
    // up to ~4/3 of the binary length — apply the limit to the decoded bytes.
    let payload: Buffer;
    try {
      payload = Buffer.from(dto.encryptedPayload, 'base64');
    } catch {
      throw new PayloadTooLargeException();
    }
    if (payload.length === 0 || payload.length > 4 * 1024) {
      throw new PayloadTooLargeException();
    }

    return this.dataSource.transaction(async (manager) => {
      const sessionRepo = manager.getRepository(DeviceLinkSession);
      const deviceRepo = manager.getRepository(UserDevice);

      const row = await sessionRepo.findOne({
        where: { sessionId: dto.sessionId },
      });
      if (!row) throw new SessionNotFoundException();
      this.assertNotExpired(row);
      if (row.status !== DeviceLinkSessionStatus.PUBKEY_SHARED) {
        throw new SessionNotPubkeySharedException();
      }
      if (row.primaryUserId !== primaryUserId) {
        // Defensive: the JWT used at /share-pubkey must match the JWT used at
        // /complete. Otherwise an attacker with a stolen session could try to
        // hijack the encrypted payload upload.
        throw new PubkeyMismatchException();
      }

      const activeCount = await deviceRepo.count({
        where: [
          { userId: primaryUserId, status: UserDeviceStatus.ACTIVE },
          { userId: primaryUserId, status: UserDeviceStatus.PENDING_LINK },
        ],
      });
      if (activeCount >= this.deviceCap()) {
        throw new DeviceLimitReachedException();
      }

      const maxRow = await deviceRepo
        .createQueryBuilder('d')
        .select('MAX(d.device_id)', 'maxDeviceId')
        .where('d.user_id = :userId', { userId: primaryUserId })
        .getRawOne<{ maxDeviceId: number | string | null }>();
      const maxDeviceId = Number(maxRow?.maxDeviceId ?? 0);
      const assignedDeviceId = Math.max(maxDeviceId + 1, PRIMARY_DEVICE_ID + 1);

      const device = deviceRepo.create({
        userId: primaryUserId,
        deviceId: assignedDeviceId,
        identityPublicKey: '',
        registrationId: 0,
        status: UserDeviceStatus.PENDING_LINK,
        deviceName: row.deviceName ?? null,
        userAgent: row.userAgent ?? null,
      });
      await deviceRepo.save(device);

      row.encryptedPayload = payload;
      row.assignedDeviceId = assignedDeviceId;
      row.status = DeviceLinkSessionStatus.COMPLETED;
      // Extend TTL on the result window — the new device has another 5 min
      // to poll once the primary has uploaded the payload.
      row.expiresAt = Date.now() + this.linkTtlMs();
      await sessionRepo.save(row);

      return {
        assignedDeviceId,
        expiresAt: new Date(Number(row.expiresAt)).toISOString(),
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /auth/devices/link/session/:sessionId/result  (anon, one-time-use)
  // ──────────────────────────────────────────────────────────────────────────

  async getLinkResult(sessionId: string): Promise<LinkResultResponse> {
    const row = await this.sessionRepo.findOne({ where: { sessionId } });
    if (!row) throw new SessionNotFoundException();
    if (row.status === DeviceLinkSessionStatus.CONSUMED) {
      throw new SessionAlreadyConsumedException();
    }
    if (this.isExpired(row)) {
      throw new SessionExpiredException();
    }

    if (row.status === DeviceLinkSessionStatus.WAITING) {
      return { status: 'pending' };
    }

    if (row.status === DeviceLinkSessionStatus.PUBKEY_SHARED) {
      const identityKeyPub = await this.lookupPrimaryIdentityKey(
        row.primaryUserId ?? null,
      );
      return {
        status: 'pubkey-shared',
        primaryEphemeralPublicKey: row.primaryEphemeralPubKey ?? undefined,
        primaryUserId: row.primaryUserId ?? undefined,
        identityKeyPub,
      };
    }

    // COMPLETED → return everything the new device needs (P_pub, primaryUserId,
    // identityKeyPub redundantly with the previous pubkey-shared fetch so the
    // first poll after complete is self-sufficient) plus the encrypted payload
    // and the assigned device id. Then mark consumed and drop sensitive bits.
    const identityKeyPub = await this.lookupPrimaryIdentityKey(
      row.primaryUserId ?? null,
    );
    const payloadBase64 = row.encryptedPayload
      ? Buffer.from(row.encryptedPayload).toString('base64')
      : undefined;
    const response: LinkResultResponse = {
      status: 'completed',
      assignedDeviceId: row.assignedDeviceId ?? undefined,
      encryptedPayload: payloadBase64,
      primaryEphemeralPublicKey: row.primaryEphemeralPubKey ?? undefined,
      primaryUserId: row.primaryUserId ?? undefined,
      identityKeyPub,
    };

    // One-time-use: drop sensitive material from storage as soon as the new
    // device reads it. Keep the row in 'consumed' state so a second read
    // gets the dedicated error code (not a generic "not found").
    row.status = DeviceLinkSessionStatus.CONSUMED;
    row.consumedAt = Date.now();
    row.encryptedPayload = null;
    row.primaryEphemeralPubKey = null;
    await this.sessionRepo.save(row);

    return response;
  }

  /**
   * Look up the primary user's published `identityPublicKey`. Already public
   * (also exposed via `GET /keys/:userId`). Used to give the new device the
   * fourth SN input before /complete so both sides can compare safety numbers
   * symmetrically. Throws PRIMARY_IDENTITY_NOT_PUBLISHED in the (degenerate)
   * case where the row has no primary attached yet or the user has no
   * identity key on record.
   */
  private async lookupPrimaryIdentityKey(
    primaryUserId: number | null,
  ): Promise<string> {
    if (primaryUserId == null) {
      throw new PrimaryIdentityNotPublishedException();
    }
    const user = await this.userRepo.findOne({
      where: { id: primaryUserId },
      select: ['id', 'identityPublicKey'],
    });
    if (!user || !user.identityPublicKey) {
      throw new PrimaryIdentityNotPublishedException();
    }
    return user.identityPublicKey;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers used by other services
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Mark the new device active once it has uploaded its key bundle.
   * Called from KeysService at the end of `POST /keys`. Emits the
   * `deviceLinked` socket event to the primary so its UI can refresh.
   */
  async markDeviceActiveAfterKeyUpload(
    userId: number,
    deviceId: number,
  ): Promise<void> {
    const device = await this.deviceRepo.findOne({
      where: { userId, deviceId },
    });
    if (!device) return;
    if (device.status !== UserDeviceStatus.PENDING_LINK) return;

    device.status = UserDeviceStatus.ACTIVE;
    await this.deviceRepo.save(device);

    const linkedAt = new Date().toISOString();
    this.notifier?.notifyDeviceLinked(userId, {
      deviceId,
      deviceName: device.deviceName ?? device.name ?? `Device ${deviceId}`,
      linkedAt,
    });

    // Fan out a minimal invalidation signal to peers (users sharing at least
    // one room) so their `deviceMap[userId]` cache picks up the new deviceId
    // near-realtime. Spec: `_shared/api/peer-device-linked.md`. Best-effort:
    // offline peers will discover the new device via `syncRoomMembersAndSessions`
    // on next reconnect.
    await this.notifier?.notifyPeersDeviceLinked?.(userId, deviceId, linkedAt);
  }

  async isDeviceRevoked(userId: number, deviceId: number): Promise<boolean> {
    const device = await this.deviceRepo.findOne({
      where: { userId, deviceId },
    });
    return device?.status === UserDeviceStatus.REVOKED;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Maintenance
  // ──────────────────────────────────────────────────────────────────────────

  async cleanupExpiredSessions(): Promise<number> {
    // Soft-expire entries first so the new device can still distinguish
    // "expired" from "never existed". Hard-delete after a 1h grace window
    // (only sessions that were never consumed — completed→consumed rows
    // age out naturally through the `consumed_at < cutoff` path).
    const nowMs = Date.now();
    const expireResult = await this.sessionRepo
      .createQueryBuilder()
      .update(DeviceLinkSession)
      .set({ status: DeviceLinkSessionStatus.EXPIRED })
      .where('expires_at <= :now', { now: nowMs })
      .andWhere('status = :waiting', {
        waiting: DeviceLinkSessionStatus.WAITING,
      })
      .execute();

    const hardDeleteCutoffMs = nowMs - 60 * 60 * 1000;
    await this.sessionRepo.delete({
      expiresAt: LessThan(hardDeleteCutoffMs),
      consumedAt: IsNull(),
    });

    return expireResult.affected ?? 0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Privates
  // ──────────────────────────────────────────────────────────────────────────

  private assertEphemeralKey(value: string): void {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value, 'base64');
    } catch {
      throw new InvalidEphemeralKeyException();
    }
    if (bytes.length !== 32) {
      throw new InvalidEphemeralKeyException();
    }
  }

  private assertNotExpired(row: DeviceLinkSession): void {
    if (this.isExpired(row)) {
      throw new SessionExpiredException();
    }
  }

  private isExpired(row: DeviceLinkSession): boolean {
    if (row.status === DeviceLinkSessionStatus.EXPIRED) return true;
    return Number(row.expiresAt) <= Date.now();
  }

  private deviceCap(): number {
    return parseInt(
      process.env.MULTI_DEVICE_CAP || String(DEFAULT_DEVICE_CAP),
      10,
    );
  }

  private openSessionCap(): number {
    return parseInt(
      process.env.MULTI_DEVICE_OPEN_TOKEN_CAP ||
        String(DEFAULT_OPEN_SESSION_CAP),
      10,
    );
  }

  private linkTtlMs(): number {
    return parseInt(
      process.env.DEVICE_LINK_TTL_MS || String(DEFAULT_LINK_TTL_MS),
      10,
    );
  }
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Implemented by the chat gateway. We pass it in at runtime to avoid a
 * circular dep between the auth module (DeviceLinkService) and the chat
 * module (ChatGateway / Socket.IO server).
 */
export interface DeviceLinkNotifier {
  notifyDeviceLinked(
    primaryUserId: number,
    payload: { deviceId: number; deviceName: string; linkedAt: string },
  ): void;
  notifyPeersDeviceRevoked(
    revokedUserId: number,
    revokedDeviceId: number,
    revokedAt: string,
  ): Promise<void>;
  notifyPeersDeviceLinked?(
    linkedUserId: number,
    addedDeviceId: number,
    linkedAt: string,
  ): Promise<void> | void;
  notifyDeviceItselfRevoked(
    revokedUserId: number,
    revokedDeviceId: number,
    revokedAt: string,
  ): Promise<void>;
  disconnectDeviceSockets(
    revokedUserId: number,
    revokedDeviceId: number,
  ): Promise<void>;
  notifyNewDeviceSenderKeys(
    userId: number,
    deviceId: number,
    rooms: Array<{ roomId: number; count: number }>,
  ): void;
}
