import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PublicKey } from '@signalapp/libsignal-client';
import { Repository, DataSource, In } from 'typeorm';
import { SignalKey, KeyTypeId } from '../../../entities/signal-key.entity';
import { User } from '../../../entities/user.entity';
import {
  UserDevice,
  UserDeviceStatus,
} from '../../../entities/user-device.entity';
import { KeyDto, KeyStatusDto, SignedKeyDto } from '../dto/keys.dto';
import { DeviceLinkService } from '../../../auth/services/device-link.service';

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    @InjectRepository(SignalKey)
    private signalKeyRepository: Repository<SignalKey>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserDevice)
    private userDeviceRepository: Repository<UserDevice>,
    private dataSource: DataSource,
    private deviceLinkService: DeviceLinkService,
  ) {}

  /**
   * Upload Signal Protocol keys for a device
   */
  async uploadKeys(
    userId: number,
    deviceId: number,
    identityPublicKey?: string,
    registrationId?: number,
    signedPreKey?: SignedKeyDto,
    preKeys?: KeyDto[],
    kyberPreKeys?: KeyDto[],
    deviceAuthPublicKey?: string,
  ): Promise<void> {
    // Verify user exists
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    this.logger.log(`Uploading keys for user ${userId}, device ${deviceId}`);

    // Upsert identity key and registration ID in user_devices table
    if (identityPublicKey && registrationId !== undefined) {
      await this.upsertUserDevice(
        userId,
        deviceId,
        registrationId,
        identityPublicKey,
        deviceAuthPublicKey,
      );
    } else if (deviceAuthPublicKey !== undefined) {
      // Auth-key-only registration on an existing device (e.g. a client that
      // upgrades and registers its device-auth key without re-uploading the
      // identity). No-op if the row doesn't exist yet.
      await this.bindDeviceAuthKeyOnly(userId, deviceId, deviceAuthPublicKey);
    }

    if (signedPreKey) {
      await this.upsertSingleKey(
        userId,
        deviceId,
        KeyTypeId.SIGNED_PRE_KEY,
        signedPreKey.keyId,
        signedPreKey.keyData,
        signedPreKey.signature,
      );
    }

    // Upload pre-keys (NO signature for standard pre-keys)
    if (preKeys && preKeys.length > 0) {
      const keys = preKeys.map((key) =>
        this.signalKeyRepository.create({
          userId,
          deviceId: String(deviceId),
          keyTypeId: KeyTypeId.PRE_KEY,
          keyId: key.keyId,
          keyData: key.keyData,
          keySignature: null, // Pre-keys don't have signatures
          consumed: false,
        }),
      );
      await this.signalKeyRepository.save(keys);
    }

    // Upload Kyber pre-keys (post-quantum) WITH signature
    if (kyberPreKeys && kyberPreKeys.length > 0) {
      const keys = kyberPreKeys.map((key) =>
        this.signalKeyRepository.create({
          userId,
          deviceId: String(deviceId),
          keyTypeId: KeyTypeId.KYBER_PRE_KEY,
          keyId: key.keyId,
          keyData: key.keyData,
          keySignature: key.signature || null,
          consumed: false,
        }),
      );
      await this.signalKeyRepository.save(keys);
    }

    // Multi-device pairing: a new device uploads its bundle right after
    // consuming the provisioning payload. Flip the row from 'pending_link'
    // to 'active' so peers can start fetching its bundle via /keys/:userId
    // and the primary's UI updates.
    if (deviceId !== 1) {
      await this.deviceLinkService.markDeviceActiveAfterKeyUpload(
        userId,
        deviceId,
      );
    }
  }

  /**
   * Get keys for a specific user and device
   */
  async getKeysForUser(userId: number, deviceId: string): Promise<SignalKey[]> {
    return this.signalKeyRepository.find({
      where: {
        userId,
        deviceId,
        consumed: false,
      },
      order: {
        createdAt: 'ASC',
      },
    });
  }

  /**
   * Consume a pre-key (mark as used)
   * Returns the key and marks it as consumed
   */
  async consumePreKey(
    userId: number,
    deviceId: string,
  ): Promise<SignalKey | null> {
    // Get the oldest unconsumed pre-key
    const key = await this.signalKeyRepository.findOne({
      where: {
        userId,
        deviceId,
        keyTypeId: KeyTypeId.PRE_KEY,
        consumed: false,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    if (!key) {
      return null;
    }

    // Mark as consumed
    key.consumed = true;
    await this.signalKeyRepository.save(key);

    return key;
  }

  /**
   * Get key status for current user
   */
  async getKeyStatus(userId: number): Promise<KeyStatusDto> {
    const keys = await this.signalKeyRepository.find({
      where: { userId, consumed: false },
    });

    const preKeysCount = keys.filter(
      (k) => (k.keyTypeId as KeyTypeId) === KeyTypeId.PRE_KEY,
    ).length;
    const kyberPreKeysCount = keys.filter(
      (k) => (k.keyTypeId as KeyTypeId) === KeyTypeId.KYBER_PRE_KEY,
    ).length;

    // Check if identity key exists in user_devices
    const devices = await this.userDeviceRepository.find({
      where: { userId },
    });
    const identityKeyPresent = devices.length > 0;

    const signedPreKeyPresent = keys.some(
      (k) => (k.keyTypeId as KeyTypeId) === KeyTypeId.SIGNED_PRE_KEY,
    );

    // Get unique device IDs from both tables
    const signalKeyDeviceIds = [...new Set(keys.map((k) => k.deviceId))];
    const userDeviceIds = devices.map((d) => String(d.deviceId));
    const deviceIds = [...new Set([...signalKeyDeviceIds, ...userDeviceIds])];

    return {
      preKeysCount,
      kyberPreKeysCount,
      deviceIds,
      identityKeyPresent,
      signedPreKeyPresent,
    };
  }

  /**
   * Multi-device fan-out: return one bundle per active device.
   *
   * Each device contributes its own signed pre-key, kyber pre-key and pre-key
   * (consumed atomically inside a per-device transaction). The `identityKey`
   * is user-level — every entry carries the same value so callers can also
   * verify it against the value used during pairing (safety number check).
   */
  async getAvailableKeysForUserDevices(userId: number): Promise<{
    devices: Array<{
      deviceId: number;
      registrationId: number | null;
      identityKey: string | null;
      signedPreKey: {
        keyId: number;
        keyData: string;
        signature: string | null;
        deviceId: number;
      } | null;
      preKey: {
        keyId: number;
        keyData: string;
        deviceId: number;
      } | null;
      kyberPreKey: {
        keyId: number;
        keyData: string;
        signature: string | null;
        deviceId: number;
      } | null;
    }>;
  }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    const identityKey = user?.identityPublicKey ?? null;

    // Active devices only — revoked/pending_link are filtered out so peers
    // never try to start a session with a device that can't decrypt.
    const activeDevices = await this.userDeviceRepository.find({
      where: { userId, status: UserDeviceStatus.ACTIVE },
      order: { deviceId: 'ASC' },
    });

    if (activeDevices.length === 0) {
      // Backward compat: pre-multi-device users have no `status` column
      // populated yet (or have legacy rows with status='active' by default).
      // Falling through here means the response is `{ devices: [] }` which is
      // valid — the client treats it as "no bundles available".
      return { devices: [] };
    }

    const devices = [];
    for (const device of activeDevices) {
      const bundle = await this.consumeBundleForDevice(userId, device.deviceId);
      // deviceName is intentionally omitted — ADR-0001 P-2: it must never
      // leak to peers, only the primary sees it via GET /auth/devices.
      devices.push({
        deviceId: device.deviceId,
        registrationId: device.registrationId || null,
        identityKey,
        signedPreKey: bundle.signedPreKey
          ? {
              keyId: bundle.signedPreKey.keyId,
              keyData: bundle.signedPreKey.keyData,
              signature: bundle.signedPreKey.keySignature ?? null,
              deviceId: device.deviceId,
            }
          : null,
        preKey: bundle.preKey
          ? {
              keyId: bundle.preKey.keyId,
              keyData: bundle.preKey.keyData,
              deviceId: device.deviceId,
            }
          : null,
        kyberPreKey: bundle.kyberPreKey
          ? {
              keyId: bundle.kyberPreKey.keyId,
              keyData: bundle.kyberPreKey.keyData,
              signature: bundle.kyberPreKey.keySignature ?? null,
              deviceId: device.deviceId,
            }
          : null,
      });

      // Touch lastActive — call here so /keys/:userId acts as a presence
      // signal for the primary device's `lastSeen` column in the listing.
      device.lastActiveAt = new Date();
      await this.userDeviceRepository.save(device);
    }

    return { devices };
  }

  /**
   * Consume one pre-key + kyber + return the signed pre-key for a single
   * (userId, deviceId) inside a transaction (race-safe).
   */
  private async consumeBundleForDevice(
    userId: number,
    deviceId: number,
  ): Promise<{
    signedPreKey: SignalKey | null;
    preKey: SignalKey | null;
    kyberPreKey: SignalKey | null;
  }> {
    const deviceIdStr = String(deviceId);
    const signedPreKey = await this.signalKeyRepository.findOne({
      where: {
        userId,
        deviceId: deviceIdStr,
        keyTypeId: KeyTypeId.SIGNED_PRE_KEY,
      },
      order: { createdAt: 'DESC' },
    });

    const { preKey, kyberPreKey } = await this.dataSource.transaction(
      async (manager) => {
        const keyRepo = manager.getRepository(SignalKey);
        const pk = await keyRepo.findOne({
          where: {
            userId,
            deviceId: deviceIdStr,
            keyTypeId: KeyTypeId.PRE_KEY,
            consumed: false,
          },
          order: { createdAt: 'ASC' },
        });
        if (pk) {
          pk.consumed = true;
          await keyRepo.save(pk);
        }
        const kpk = await keyRepo.findOne({
          where: {
            userId,
            deviceId: deviceIdStr,
            keyTypeId: KeyTypeId.KYBER_PRE_KEY,
            consumed: false,
          },
          order: { createdAt: 'ASC' },
        });
        if (kpk) {
          kpk.consumed = true;
          await keyRepo.save(kpk);
        }
        return { preKey: pk, kyberPreKey: kpk };
      },
    );

    return { signedPreKey, preKey, kyberPreKey };
  }

  /**
   * Get all available keys for a user (for consumption by recipient)
   */
  async getAvailableKeysForUser(userId: number): Promise<{
    userDevice: UserDevice | null;
    signedPreKey: SignalKey | null;
    preKey: SignalKey | null;
    kyberPreKey: SignalKey | null;
  }> {
    this.logger.debug(`Fetching available keys for user ${userId}`);

    // Get identity key and registration ID from user_devices
    const userDevice = await this.userDeviceRepository.findOne({
      where: { userId },
      order: { lastActiveAt: 'DESC' },
    });

    const signedPreKey = await this.signalKeyRepository.findOne({
      where: {
        userId,
        keyTypeId: KeyTypeId.SIGNED_PRE_KEY,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    // Atomically consume one pre-key and one Kyber pre-key inside a transaction
    // to prevent race conditions (double-spend of the same key)
    const { preKey, kyberPreKey } = await this.dataSource.transaction(
      async (manager) => {
        const keyRepo = manager.getRepository(SignalKey);

        // Fetch and immediately mark pre-key as consumed
        const pk = await keyRepo.findOne({
          where: {
            userId,
            keyTypeId: KeyTypeId.PRE_KEY,
            consumed: false,
          },
          order: { createdAt: 'ASC' },
        });

        if (pk) {
          pk.consumed = true;
          await keyRepo.save(pk);
        }

        // Fetch and immediately mark Kyber pre-key as consumed
        const kpk = await keyRepo.findOne({
          where: {
            userId,
            keyTypeId: KeyTypeId.KYBER_PRE_KEY,
            consumed: false,
          },
          order: { createdAt: 'ASC' },
        });

        if (kpk) {
          kpk.consumed = true;
          await keyRepo.save(kpk);
        }

        return { preKey: pk, kyberPreKey: kpk };
      },
    );

    if (!userDevice || !signedPreKey || !preKey || !kyberPreKey) {
      this.logger.warn(
        `Missing keys for user ${userId}: userDevice=${!!userDevice}, signed=${!!signedPreKey}, preKey=${!!preKey}, kyberPreKey=${!!kyberPreKey}`,
      );
    }

    // Update last active timestamp for the device
    if (userDevice) {
      userDevice.lastActiveAt = new Date();
      await this.userDeviceRepository.save(userDevice);
    }

    return { userDevice, signedPreKey, preKey, kyberPreKey };
  }

  private async upsertSingleKey(
    userId: number,
    deviceId: number,
    keyTypeId: KeyTypeId,
    keyId: number,
    keyData: string,
    keySignature?: string,
  ): Promise<void> {
    const deviceIdStr = String(deviceId);
    const existing = await this.signalKeyRepository.findOne({
      where: {
        userId,
        deviceId: deviceIdStr,
        keyTypeId,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    if (existing) {
      existing.keyId = keyId;
      existing.keyData = keyData;
      existing.keySignature = keySignature ?? null;
      existing.consumed = false;
      await this.signalKeyRepository.save(existing);
      return;
    }

    const key = this.signalKeyRepository.create({
      userId,
      deviceId: deviceIdStr,
      keyTypeId,
      keyId,
      keyData,
      keySignature: keySignature ?? null,
      consumed: false,
    });

    await this.signalKeyRepository.save(key);
  }

  private async upsertUserDevice(
    userId: number,
    deviceId: number,
    registrationId: number,
    identityPublicKey: string,
    deviceAuthPublicKey?: string,
  ): Promise<void> {
    const existing = await this.userDeviceRepository.findOne({
      where: { userId, deviceId },
    });

    if (existing) {
      existing.registrationId = registrationId;
      existing.identityPublicKey = identityPublicKey;
      existing.lastActiveAt = new Date();
      this.applyDeviceAuthKey(existing, deviceAuthPublicKey);
      await this.userDeviceRepository.save(existing);
      return;
    }

    const device = this.userDeviceRepository.create({
      userId,
      deviceId,
      registrationId,
      identityPublicKey,
    });
    // Route the first bind through applyDeviceAuthKey so the key is validated
    // (DEVICE_AUTH_KEY_INVALID on a non-deserializable key) exactly like the
    // existing-row path — otherwise a malformed key on a brand-new device row
    // would be stored unvalidated and brick login (no recovery, ADR-0011).
    this.applyDeviceAuthKey(device, deviceAuthPublicKey);

    await this.userDeviceRepository.save(device);
  }

  /**
   * Bind the device-auth key on an existing device row without touching the
   * identity (auth-key-only `POST /keys`). No-op if the row doesn't exist yet.
   */
  private async bindDeviceAuthKeyOnly(
    userId: number,
    deviceId: number,
    deviceAuthPublicKey: string,
  ): Promise<void> {
    const existing = await this.userDeviceRepository.findOne({
      where: { userId, deviceId },
    });
    if (!existing) return;
    this.applyDeviceAuthKey(existing, deviceAuthPublicKey);
    await this.userDeviceRepository.save(existing);
  }

  /**
   * Apply the per-device server-auth key (ADR-0010) to a device row. Mutates
   * `device.authPublicKey`. TOFU on first bind; idempotent for the same key;
   * `DEVICE_AUTH_MISMATCH` on a silent re-bind attempt. There is no recovery
   * override (ADR-0011): a lost primary auth key is not server-recoverable.
   */
  private applyDeviceAuthKey(
    device: UserDevice,
    deviceAuthPublicKey: string | undefined,
  ): void {
    if (deviceAuthPublicKey === undefined) return;
    if (!device.authPublicKey) {
      // Validate the key actually parses as a libsignal public key BEFORE the
      // TOFU bind. Otherwise a malformed key gets stored and `PublicKey.
      // deserialize` throws at every subsequent login → permanent
      // `DEVICE_AUTH_INVALID`. With no server-side recovery (ADR-0011) that
      // bricks the account, so reject the bad key here with a 400 instead.
      this.assertParseableAuthKey(deviceAuthPublicKey);
      device.authPublicKey = deviceAuthPublicKey; // trust-on-first-use bind
      return;
    }
    if (device.authPublicKey === deviceAuthPublicKey) return; // idempotent
    // Different key on an already-bound device — never silently re-bound.
    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: 'DEVICE_AUTH_MISMATCH',
    });
  }

  /**
   * Reject a `deviceAuthPublicKey` that is not a deserializable libsignal
   * public key before it is ever stored (ADR-0010/0011). Mirrors the
   * `PublicKey.deserialize` the login path runs, so a key that binds here is
   * guaranteed to be verifiable later.
   */
  private assertParseableAuthKey(deviceAuthPublicKey: string): void {
    try {
      PublicKey.deserialize(Buffer.from(deviceAuthPublicKey, 'base64'));
    } catch {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'DEVICE_AUTH_KEY_INVALID',
      });
    }
  }
}
