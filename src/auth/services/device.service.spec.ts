import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DeviceService } from './device.service';
import {
  UserDevice,
  UserDeviceStatus,
} from '../../entities/user-device.entity';
import { SignalKey } from '../../entities/signal-key.entity';
import { DeviceLinkService } from './device-link.service';
import { PRIMARY_DEVICE_ID } from '../dto/device-link.dto';
import { createMockRepository } from '../../test/helpers';

describe('DeviceService', () => {
  let service: DeviceService;
  let deviceRepo: ReturnType<typeof createMockRepository>;
  let signalKeyRepo: ReturnType<typeof createMockRepository>;
  let deviceLinkService: { markDeviceRevokedInCache: jest.Mock };

  const makeNotifier = () => ({
    notifyDeviceLinked: jest.fn(),
    notifyPeersDeviceRevoked: jest.fn().mockResolvedValue(undefined),
    notifyDeviceItselfRevoked: jest.fn().mockResolvedValue(undefined),
    disconnectDeviceSockets: jest.fn().mockResolvedValue(undefined),
    notifyNewDeviceSenderKeys: jest.fn(),
    notifyPeersDeviceLinked: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(async () => {
    deviceRepo = createMockRepository();
    signalKeyRepo = createMockRepository();
    deviceLinkService = { markDeviceRevokedInCache: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceService,
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SignalKey), useValue: signalKeyRepo },
        { provide: DeviceLinkService, useValue: deviceLinkService },
      ],
    }).compile();

    service = module.get(DeviceService);
  });

  describe('listDevices', () => {
    it('PRIMARY_REQUIRED when a linked device calls it', async () => {
      await expect(service.listDevices(1, 2)).rejects.toMatchObject({
        response: { error: 'PRIMARY_REQUIRED' },
      });
    });

    it('hides revoked devices older than 30 days but keeps recent ones', async () => {
      const now = Date.now();
      deviceRepo.find.mockResolvedValue([
        {
          deviceId: 1,
          status: UserDeviceStatus.ACTIVE,
          createdAt: new Date(),
          lastActiveAt: new Date(),
          deviceName: 'Primary',
        },
        {
          deviceId: 2,
          status: UserDeviceStatus.REVOKED,
          createdAt: new Date(),
          lastActiveAt: null,
          revokedAt: now - 40 * 24 * 60 * 60 * 1000, // 40 days ago
        },
        {
          deviceId: 3,
          status: UserDeviceStatus.REVOKED,
          createdAt: new Date(),
          lastActiveAt: null,
          revokedAt: now - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        },
      ]);

      const { devices } = await service.listDevices(1, PRIMARY_DEVICE_ID);

      const ids = devices.map((d) => d.deviceId);
      expect(ids).toContain(1);
      expect(ids).toContain(3);
      expect(ids).not.toContain(2); // 40-day-old revoked row hidden
      const primary = devices.find((d) => d.deviceId === 1)!;
      expect(primary.isPrimary).toBe(true);
      expect(primary.isCurrent).toBe(true);
    });
  });

  describe('revokeDevice', () => {
    it('PRIMARY_REQUIRED when caller is not the primary', async () => {
      await expect(service.revokeDevice(1, 2, 3)).rejects.toMatchObject({
        response: { error: 'PRIMARY_REQUIRED' },
      });
    });

    it('CANNOT_REVOKE_PRIMARY when targeting device 1', async () => {
      await expect(
        service.revokeDevice(1, PRIMARY_DEVICE_ID, PRIMARY_DEVICE_ID),
      ).rejects.toMatchObject({ response: { error: 'CANNOT_REVOKE_PRIMARY' } });
    });

    it('DEVICE_NOT_FOUND when the target device does not exist', async () => {
      deviceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.revokeDevice(1, PRIMARY_DEVICE_ID, 2),
      ).rejects.toMatchObject({ response: { error: 'DEVICE_NOT_FOUND' } });
    });

    it('ALREADY_REVOKED when the device is already revoked', async () => {
      deviceRepo.findOne.mockResolvedValue({
        userId: 1,
        deviceId: 2,
        status: UserDeviceStatus.REVOKED,
      });

      await expect(
        service.revokeDevice(1, PRIMARY_DEVICE_ID, 2),
      ).rejects.toMatchObject({ response: { error: 'ALREADY_REVOKED' } });
    });

    it('revokes: flips status, drops pre-keys, pokes the cache, notifies in order', async () => {
      const device = {
        userId: 1,
        deviceId: 2,
        status: UserDeviceStatus.ACTIVE,
      };
      deviceRepo.findOne.mockResolvedValue(device);

      const calls: string[] = [];
      const notifier = makeNotifier();
      notifier.notifyDeviceItselfRevoked.mockImplementation(async () => {
        calls.push('itself');
      });
      notifier.notifyPeersDeviceRevoked.mockImplementation(async () => {
        calls.push('peers');
      });
      notifier.disconnectDeviceSockets.mockImplementation(async () => {
        calls.push('disconnect');
      });
      service.setNotifier(notifier as any);

      const result = await service.revokeDevice(1, PRIMARY_DEVICE_ID, 2);

      expect(device.status).toBe(UserDeviceStatus.REVOKED);
      expect(deviceRepo.save).toHaveBeenCalledWith(device);
      // Pre-keys dropped for the revoked (userId, deviceId) — deviceId stringified.
      expect(signalKeyRepo.delete).toHaveBeenCalledWith({
        userId: 1,
        deviceId: '2',
      });
      expect(deviceLinkService.markDeviceRevokedInCache).toHaveBeenCalledWith(
        1,
        2,
      );
      // Revoked device learns first, then peers, then its socket is dropped.
      expect(calls).toEqual(['itself', 'peers', 'disconnect']);
      expect(result).toMatchObject({ deviceId: 2, status: 'revoked' });
      expect(result.revokedAt).toEqual(expect.any(String));
    });
  });

  describe('revokeSelf', () => {
    it('CANNOT_REVOKE_PRIMARY for the primary device', async () => {
      await expect(
        service.revokeSelf(1, PRIMARY_DEVICE_ID),
      ).rejects.toMatchObject({ response: { error: 'CANNOT_REVOKE_PRIMARY' } });
    });

    it('self-revokes a linked device without emitting deviceRevoked back to itself', async () => {
      const device = {
        userId: 1,
        deviceId: 3,
        status: UserDeviceStatus.ACTIVE,
      };
      deviceRepo.findOne.mockResolvedValue(device);
      const notifier = makeNotifier();
      service.setNotifier(notifier as any);

      const result = await service.revokeSelf(1, 3);

      expect(device.status).toBe(UserDeviceStatus.REVOKED);
      expect(deviceLinkService.markDeviceRevokedInCache).toHaveBeenCalledWith(
        1,
        3,
      );
      // isSelf=true → don't echo deviceRevoked{self:true} to the caller…
      expect(notifier.notifyDeviceItselfRevoked).not.toHaveBeenCalled();
      // …but peers are still told and the socket is dropped.
      expect(notifier.notifyPeersDeviceRevoked).toHaveBeenCalledWith(
        1,
        3,
        expect.any(String),
      );
      expect(notifier.disconnectDeviceSockets).toHaveBeenCalledWith(1, 3);
      expect(result).toMatchObject({ deviceId: 3, status: 'revoked' });
    });
  });
});
