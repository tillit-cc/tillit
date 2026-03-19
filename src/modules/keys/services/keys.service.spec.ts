import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { KeysService } from './keys.service';
import { SignalKey, KeyTypeId } from '../../../entities/signal-key.entity';
import { User } from '../../../entities/user.entity';
import { UserDevice } from '../../../entities/user-device.entity';
import {
  createMockRepository,
  makeUser,
  makeSignalKey,
  makeUserDevice,
} from '../../../test/helpers';

describe('KeysService', () => {
  let service: KeysService;
  let signalKeyRepo: ReturnType<typeof createMockRepository>;
  let userRepo: ReturnType<typeof createMockRepository>;
  let userDeviceRepo: ReturnType<typeof createMockRepository>;
  let txKeyRepo: ReturnType<typeof createMockRepository>;
  let mockDataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    signalKeyRepo = createMockRepository();
    userRepo = createMockRepository();
    userDeviceRepo = createMockRepository();
    txKeyRepo = createMockRepository();

    mockDataSource = {
      transaction: jest.fn((cb: (manager: any) => Promise<any>) =>
        cb({ getRepository: () => txKeyRepo }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeysService,
        { provide: getRepositoryToken(SignalKey), useValue: signalKeyRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(UserDevice), useValue: userDeviceRepo },
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    service = module.get<KeysService>(KeysService);
  });

  describe('uploadKeys', () => {
    it('should save pre-keys, kyber keys, and signed pre-key', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      signalKeyRepo.findOne.mockResolvedValue(null); // no existing signed pre-key
      userDeviceRepo.findOne.mockResolvedValue(null); // new device

      await service.uploadKeys(
        1,
        1,
        'identity-key',
        12345,
        { keyId: 1, keyData: 'signed-data', signature: 'sig' },
        [{ keyId: 100, keyData: 'prekey-data' }],
        [{ keyId: 200, keyData: 'kyber-data', signature: 'kyber-sig' }],
      );

      // Should upsert user device
      expect(userDeviceRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          deviceId: 1,
          registrationId: 12345,
          identityPublicKey: 'identity-key',
        }),
      );

      // Should save pre-keys
      expect(signalKeyRepo.save).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException if user not found', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.uploadKeys(999, 1)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should upsert existing user device', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      const existingDevice = makeUserDevice({ id: 1, userId: 1, deviceId: 1 });
      userDeviceRepo.findOne.mockResolvedValue(existingDevice);
      signalKeyRepo.findOne.mockResolvedValue(null);

      await service.uploadKeys(1, 1, 'new-identity-key', 54321);

      expect(userDeviceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationId: 54321,
          identityPublicKey: 'new-identity-key',
        }),
      );
    });

    it('should skip optional fields when not provided', async () => {
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));

      await service.uploadKeys(1, 1);

      // Should NOT call upsertUserDevice or save keys
      expect(userDeviceRepo.findOne).not.toHaveBeenCalled();
      expect(signalKeyRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('getAvailableKeysForUser', () => {
    it('should return complete key bundle', async () => {
      const device = makeUserDevice({ userId: 1 });
      const signedPreKey = makeSignalKey({
        keyTypeId: KeyTypeId.SIGNED_PRE_KEY,
        keyData: 'signed-key',
      });
      const preKey = makeSignalKey({
        keyTypeId: KeyTypeId.PRE_KEY,
        keyData: 'pre-key',
        consumed: false,
      });
      const kyberPreKey = makeSignalKey({
        keyTypeId: KeyTypeId.KYBER_PRE_KEY,
        keyData: 'kyber-key',
        consumed: false,
      });

      userDeviceRepo.findOne.mockResolvedValue(device);
      // signedPreKey is fetched outside the transaction
      signalKeyRepo.findOne.mockResolvedValueOnce(signedPreKey);
      // preKey and kyberPreKey are fetched inside the transaction
      txKeyRepo.findOne
        .mockResolvedValueOnce(preKey)
        .mockResolvedValueOnce(kyberPreKey);

      const result = await service.getAvailableKeysForUser(1);

      expect(result.userDevice).toEqual(device);
      expect(result.signedPreKey).toEqual(signedPreKey);
      expect(result.preKey).toEqual(preKey);
      expect(result.kyberPreKey).toEqual(kyberPreKey);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it('should mark consumed pre-key and kyber key inside transaction', async () => {
      const device = makeUserDevice({ userId: 1 });
      const preKey = makeSignalKey({ consumed: false });
      const kyberPreKey = makeSignalKey({ consumed: false });

      userDeviceRepo.findOne.mockResolvedValue(device);
      signalKeyRepo.findOne.mockResolvedValueOnce(null); // signed pre-key
      txKeyRepo.findOne
        .mockResolvedValueOnce(preKey)
        .mockResolvedValueOnce(kyberPreKey);

      await service.getAvailableKeysForUser(1);

      expect(preKey.consumed).toBe(true);
      expect(kyberPreKey.consumed).toBe(true);
      // Keys are saved via the transactional repo, not the injected one
      expect(txKeyRepo.save).toHaveBeenCalledWith(preKey);
      expect(txKeyRepo.save).toHaveBeenCalledWith(kyberPreKey);
    });

    it('should update lastActiveAt on user device', async () => {
      const device = makeUserDevice({ userId: 1 });
      userDeviceRepo.findOne.mockResolvedValue(device);
      signalKeyRepo.findOne.mockResolvedValue(null);
      txKeyRepo.findOne.mockResolvedValue(null);

      await service.getAvailableKeysForUser(1);

      expect(userDeviceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ lastActiveAt: expect.any(Date) }),
      );
    });

    it('should handle missing keys gracefully (partial bundle)', async () => {
      userDeviceRepo.findOne.mockResolvedValue(null);
      signalKeyRepo.findOne.mockResolvedValue(null);
      txKeyRepo.findOne.mockResolvedValue(null);

      const result = await service.getAvailableKeysForUser(1);

      expect(result.userDevice).toBeNull();
      expect(result.signedPreKey).toBeNull();
      expect(result.preKey).toBeNull();
      expect(result.kyberPreKey).toBeNull();
    });
  });

  describe('consumePreKey', () => {
    it('should return oldest unconsumed pre-key and mark as consumed', async () => {
      const preKey = makeSignalKey({
        keyTypeId: KeyTypeId.PRE_KEY,
        consumed: false,
        keyId: 100,
      });

      signalKeyRepo.findOne.mockResolvedValue(preKey);

      const result = await service.consumePreKey(1, '1');

      expect(result).toEqual(preKey);
      expect(result!.consumed).toBe(true);
      expect(signalKeyRepo.save).toHaveBeenCalledWith(preKey);
    });

    it('should return null if no unconsumed pre-keys available', async () => {
      signalKeyRepo.findOne.mockResolvedValue(null);

      const result = await service.consumePreKey(1, '1');

      expect(result).toBeNull();
    });
  });

  describe('getKeyStatus', () => {
    it('should count available keys by type', async () => {
      signalKeyRepo.find.mockResolvedValue([
        makeSignalKey({ keyTypeId: KeyTypeId.PRE_KEY, deviceId: '1' }),
        makeSignalKey({ keyTypeId: KeyTypeId.PRE_KEY, deviceId: '1' }),
        makeSignalKey({ keyTypeId: KeyTypeId.KYBER_PRE_KEY, deviceId: '1' }),
        makeSignalKey({ keyTypeId: KeyTypeId.SIGNED_PRE_KEY, deviceId: '1' }),
      ]);
      userDeviceRepo.find.mockResolvedValue([makeUserDevice({ deviceId: 1 })]);

      const result = await service.getKeyStatus(1);

      expect(result.preKeysCount).toBe(2);
      expect(result.kyberPreKeysCount).toBe(1);
      expect(result.identityKeyPresent).toBe(true);
      expect(result.signedPreKeyPresent).toBe(true);
      expect(result.deviceIds).toContain('1');
    });

    it('should report identityKeyPresent=false when no devices', async () => {
      signalKeyRepo.find.mockResolvedValue([]);
      userDeviceRepo.find.mockResolvedValue([]);

      const result = await service.getKeyStatus(1);

      expect(result.identityKeyPresent).toBe(false);
      expect(result.preKeysCount).toBe(0);
      expect(result.kyberPreKeysCount).toBe(0);
    });
  });
});
