import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SignalKey, KeyTypeId } from '../../../entities/signal-key.entity';
import { User } from '../../../entities/user.entity';
import { UserDevice } from '../../../entities/user-device.entity';
import { KeyDto, KeyStatusDto, SignedKeyDto } from '../dto/keys.dto';

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
      );
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
  ): Promise<void> {
    const existing = await this.userDeviceRepository.findOne({
      where: { userId, deviceId },
    });

    if (existing) {
      existing.registrationId = registrationId;
      existing.identityPublicKey = identityPublicKey;
      existing.lastActiveAt = new Date();
      await this.userDeviceRepository.save(existing);
      return;
    }

    const device = this.userDeviceRepository.create({
      userId,
      deviceId,
      registrationId,
      identityPublicKey,
    });

    await this.userDeviceRepository.save(device);
  }
}
