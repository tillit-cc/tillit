import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Buffer } from 'buffer';

import { DeviceLinkService } from './device-link.service';
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
import { PRIMARY_DEVICE_ID } from '../dto/device-link.dto';
import {
  createMockRepository,
  createMockDataSource,
  makeUser,
} from '../../test/helpers';

const VALID_PUBKEY = Buffer.alloc(32, 1).toString('base64'); // 32 zero bytes
const OTHER_PUBKEY = Buffer.alloc(32, 2).toString('base64');
const VALID_PAYLOAD = Buffer.from(
  '01' + '0'.repeat(2 * 12) + 'aa'.repeat(20) + '0'.repeat(2 * 16),
  'hex',
).toString('base64');

describe('DeviceLinkService — wire v2.1 (symmetric safety number)', () => {
  let service: DeviceLinkService;
  let sessionRepo: ReturnType<typeof createMockRepository>;
  let deviceRepo: ReturnType<typeof createMockRepository>;
  let signalKeyRepo: ReturnType<typeof createMockRepository>;
  let userRepo: ReturnType<typeof createMockRepository>;
  let dataSource: ReturnType<typeof createMockDataSource>;

  beforeEach(async () => {
    sessionRepo = createMockRepository();
    deviceRepo = createMockRepository();
    signalKeyRepo = createMockRepository();
    userRepo = createMockRepository();
    dataSource = createMockDataSource();

    // The service grabs scoped repos from manager.getRepository(Entity). We
    // route each entity to its mock repo so the transactional path runs the
    // same logic as the non-transactional one.
    (dataSource as any)._mockManager.getRepository = (entity: any) => {
      if (entity === DeviceLinkSession) return sessionRepo;
      if (entity === UserDevice) return deviceRepo;
      if (entity === User) return userRepo;
      throw new Error(`Unexpected repository request: ${entity?.name}`);
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceLinkService,
        {
          provide: getRepositoryToken(DeviceLinkSession),
          useValue: sessionRepo,
        },
        { provide: getRepositoryToken(UserDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(SignalKey), useValue: signalKeyRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(DeviceLinkService);
  });

  describe('sharePubkey', () => {
    it('happy path: waiting → pubkey-shared attaches primary user/device', async () => {
      const row: any = {
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.WAITING,
        expiresAt: Date.now() + 60_000,
        primaryUserId: null,
        primaryDeviceId: null,
        primaryEphemeralPubKey: null,
      };
      sessionRepo.findOne.mockResolvedValue(row);

      const result = await service.sharePubkey(42, PRIMARY_DEVICE_ID, {
        sessionId: 'sess-1',
        primaryEphemeralPublicKey: VALID_PUBKEY,
      });

      expect(result).toEqual({ ok: true });
      expect(row.primaryUserId).toBe(42);
      expect(row.primaryDeviceId).toBe(PRIMARY_DEVICE_ID);
      expect(row.primaryEphemeralPubKey).toBe(VALID_PUBKEY);
      expect(row.status).toBe(DeviceLinkSessionStatus.PUBKEY_SHARED);
      expect(sessionRepo.save).toHaveBeenCalledWith(row);
    });

    it('idempotent: re-call with same P_pub returns ok without re-saving the row', async () => {
      const row: any = {
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryDeviceId: PRIMARY_DEVICE_ID,
        primaryEphemeralPubKey: VALID_PUBKEY,
      };
      sessionRepo.findOne.mockResolvedValue(row);

      const result = await service.sharePubkey(42, PRIMARY_DEVICE_ID, {
        sessionId: 'sess-1',
        primaryEphemeralPublicKey: VALID_PUBKEY,
      });

      expect(result).toEqual({ ok: true });
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('PUBKEY_MISMATCH on re-call with a different P_pub', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryDeviceId: PRIMARY_DEVICE_ID,
        primaryEphemeralPubKey: VALID_PUBKEY,
      });

      await expect(
        service.sharePubkey(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: OTHER_PUBKEY,
        }),
      ).rejects.toMatchObject({
        response: { error: 'PUBKEY_MISMATCH' },
      });
    });

    it('PUBKEY_MISMATCH if a different primary tries to claim the session', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryDeviceId: PRIMARY_DEVICE_ID,
        primaryEphemeralPubKey: VALID_PUBKEY,
      });

      await expect(
        service.sharePubkey(99, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: VALID_PUBKEY,
        }),
      ).rejects.toMatchObject({
        response: { error: 'PUBKEY_MISMATCH' },
      });
    });

    it('SESSION_NOT_WAITING when session is already completed', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.COMPLETED,
        expiresAt: Date.now() + 60_000,
      });

      await expect(
        service.sharePubkey(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: VALID_PUBKEY,
        }),
      ).rejects.toMatchObject({
        response: { error: 'SESSION_NOT_WAITING' },
      });
    });

    it('SESSION_EXPIRED when the session TTL is already past', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.WAITING,
        expiresAt: Date.now() - 1_000,
      });

      await expect(
        service.sharePubkey(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: VALID_PUBKEY,
        }),
      ).rejects.toMatchObject({
        response: { error: 'SESSION_EXPIRED' },
      });
    });

    it('PRIMARY_REQUIRED if the JWT belongs to a linked device', async () => {
      await expect(
        service.sharePubkey(42, 2, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: VALID_PUBKEY,
        }),
      ).rejects.toMatchObject({
        response: { error: 'PRIMARY_REQUIRED' },
      });
    });

    it('INVALID_EPHEMERAL_KEY for a non-32B X25519 public key', async () => {
      await expect(
        service.sharePubkey(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          primaryEphemeralPublicKey: Buffer.alloc(16).toString('base64'),
        }),
      ).rejects.toMatchObject({
        response: { error: 'INVALID_EPHEMERAL_KEY' },
      });
    });
  });

  describe('getLinkResult — status=pubkey-shared', () => {
    it('returns the 4-field shape including identityKeyPub from the User row', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryEphemeralPubKey: VALID_PUBKEY,
      });
      userRepo.findOne.mockResolvedValue(
        makeUser({ id: 42, identityPublicKey: 'identity-key-base64' }),
      );

      const result = await service.getLinkResult('sess-1');

      expect(result).toEqual({
        status: 'pubkey-shared',
        primaryEphemeralPublicKey: VALID_PUBKEY,
        primaryUserId: 42,
        identityKeyPub: 'identity-key-base64',
      });
      // pubkey-shared reads are NOT one-time-use — the row must NOT be saved.
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('PRIMARY_IDENTITY_NOT_PUBLISHED when the primary user has no identity key', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryEphemeralPubKey: VALID_PUBKEY,
      });
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.getLinkResult('sess-1')).rejects.toMatchObject({
        response: { error: 'PRIMARY_IDENTITY_NOT_PUBLISHED' },
      });
    });
  });

  describe('getLinkResult — status=completed', () => {
    it('returns encryptedPayload + redundant pubkey-shared fields and consumes the row', async () => {
      const row: any = {
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.COMPLETED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryEphemeralPubKey: VALID_PUBKEY,
        encryptedPayload: Buffer.from([1, 2, 3, 4]),
        assignedDeviceId: 7,
        consumedAt: null,
      };
      sessionRepo.findOne.mockResolvedValue(row);
      userRepo.findOne.mockResolvedValue(
        makeUser({ id: 42, identityPublicKey: 'identity-key-base64' }),
      );

      const result = await service.getLinkResult('sess-1');

      expect(result.status).toBe('completed');
      expect(result.assignedDeviceId).toBe(7);
      expect(result.encryptedPayload).toBe(
        Buffer.from([1, 2, 3, 4]).toString('base64'),
      );
      expect(result.primaryEphemeralPublicKey).toBe(VALID_PUBKEY);
      expect(result.primaryUserId).toBe(42);
      expect(result.identityKeyPub).toBe('identity-key-base64');

      expect(row.status).toBe(DeviceLinkSessionStatus.CONSUMED);
      expect(row.encryptedPayload).toBeNull();
      expect(row.primaryEphemeralPubKey).toBeNull();
      expect(sessionRepo.save).toHaveBeenCalledWith(row);
    });
  });

  describe('completeLink', () => {
    it('rejects a session in waiting (must go via /share-pubkey first)', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.WAITING,
        expiresAt: Date.now() + 60_000,
      });

      await expect(
        service.completeLink(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: VALID_PAYLOAD,
        }),
      ).rejects.toMatchObject({
        response: { error: 'SESSION_NOT_PUBKEY_SHARED' },
      });
    });

    it('happy path on pubkey-shared: assigns deviceId and flips to completed', async () => {
      const row: any = {
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryDeviceId: PRIMARY_DEVICE_ID,
        primaryEphemeralPubKey: VALID_PUBKEY,
        deviceName: 'iPhone',
        userAgent: 'iOS 18',
      };
      sessionRepo.findOne.mockResolvedValue(row);
      deviceRepo.count.mockResolvedValue(1);
      deviceRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ maxDeviceId: 1 }),
      });

      const result = await service.completeLink(42, PRIMARY_DEVICE_ID, {
        sessionId: 'sess-1',
        encryptedPayload: VALID_PAYLOAD,
      });

      expect(result.assignedDeviceId).toBe(2);
      expect(row.status).toBe(DeviceLinkSessionStatus.COMPLETED);
      expect(row.assignedDeviceId).toBe(2);
      expect(row.encryptedPayload).toBeInstanceOf(Buffer);
      // The pending_link device row gets created with the matching userId.
      expect(deviceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 42,
          deviceId: 2,
          status: UserDeviceStatus.PENDING_LINK,
        }),
      );
    });

    it('PUBKEY_MISMATCH if a different primary calls /complete on a shared session', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryDeviceId: PRIMARY_DEVICE_ID,
        primaryEphemeralPubKey: VALID_PUBKEY,
      });

      await expect(
        service.completeLink(99, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: VALID_PAYLOAD,
        }),
      ).rejects.toMatchObject({
        response: { error: 'PUBKEY_MISMATCH' },
      });
    });
  });

  describe('markDeviceActiveAfterKeyUpload', () => {
    it('emits deviceLinked to the primary and peerDeviceLinked to peers in order', async () => {
      deviceRepo.findOne.mockResolvedValue({
        userId: 42,
        deviceId: 2,
        status: UserDeviceStatus.PENDING_LINK,
        deviceName: 'iPhone',
      });

      const calls: string[] = [];
      const notifier = {
        notifyDeviceLinked: jest.fn(() => {
          calls.push('linked');
        }),
        notifyPeersDeviceRevoked: jest.fn(),
        notifyDeviceItselfRevoked: jest.fn(),
        disconnectDeviceSockets: jest.fn(),
        notifyNewDeviceSenderKeys: jest.fn(),
        notifyPeersDeviceLinked: jest.fn(async () => {
          calls.push('peers');
        }),
      };
      service.setNotifier(notifier as any);

      await service.markDeviceActiveAfterKeyUpload(42, 2);

      expect(notifier.notifyDeviceLinked).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          deviceId: 2,
          deviceName: 'iPhone',
          linkedAt: expect.any(String),
        }),
      );
      expect(notifier.notifyPeersDeviceLinked).toHaveBeenCalledWith(
        42,
        2,
        expect.any(String),
      );
      // Order matters per spec: own devices learn first, peers learn after the
      // device is ACTIVE and pre-keys are visible in GET /keys/:userId.
      expect(calls).toEqual(['linked', 'peers']);

      // The linkedAt sent to peers matches the one sent to the primary so
      // a client receiving both gets a consistent timestamp.
      const linkedCalls = notifier.notifyDeviceLinked.mock
        .calls as unknown as Array<[number, { linkedAt: string }]>;
      const peersCalls = notifier.notifyPeersDeviceLinked.mock
        .calls as unknown as Array<[number, number, string]>;
      expect(peersCalls[0][2]).toBe(linkedCalls[0][1].linkedAt);
    });

    it('does nothing when the device is not in pending_link state', async () => {
      deviceRepo.findOne.mockResolvedValue({
        userId: 42,
        deviceId: 2,
        status: UserDeviceStatus.ACTIVE,
      });

      const notifier = {
        notifyDeviceLinked: jest.fn(),
        notifyPeersDeviceRevoked: jest.fn(),
        notifyDeviceItselfRevoked: jest.fn(),
        disconnectDeviceSockets: jest.fn(),
        notifyNewDeviceSenderKeys: jest.fn(),
        notifyPeersDeviceLinked: jest.fn(),
      };
      service.setNotifier(notifier as any);

      await service.markDeviceActiveAfterKeyUpload(42, 2);

      expect(notifier.notifyDeviceLinked).not.toHaveBeenCalled();
      expect(notifier.notifyPeersDeviceLinked).not.toHaveBeenCalled();
    });

    it('is a no-op when the notifier is not wired or omits notifyPeersDeviceLinked', async () => {
      deviceRepo.findOne.mockResolvedValue({
        userId: 42,
        deviceId: 2,
        status: UserDeviceStatus.PENDING_LINK,
      });

      // Notifier with no notifyPeersDeviceLinked — optional method, should
      // skip silently rather than crash.
      const partialNotifier = {
        notifyDeviceLinked: jest.fn(),
        notifyPeersDeviceRevoked: jest.fn(),
        notifyDeviceItselfRevoked: jest.fn(),
        disconnectDeviceSockets: jest.fn(),
        notifyNewDeviceSenderKeys: jest.fn(),
      };
      service.setNotifier(partialNotifier as any);

      await expect(
        service.markDeviceActiveAfterKeyUpload(42, 2),
      ).resolves.toBeUndefined();
      expect(partialNotifier.notifyDeviceLinked).toHaveBeenCalled();
    });
  });
});
