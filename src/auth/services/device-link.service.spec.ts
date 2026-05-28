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
        primaryUserId: '42', // string on the wire (HKDF input)
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
    it('returns encryptedPayload + redundant pubkey-shared fields and atomically consumes the row', async () => {
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
      sessionRepo.update.mockResolvedValue({ affected: 1 });
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
      // primaryUserId is a STRING on the wire (HKDF input).
      expect(result.primaryUserId).toBe('42');
      expect(result.identityKeyPub).toBe('identity-key-base64');

      // Consumed via a conditional UPDATE gated on status=completed, not save().
      expect(sessionRepo.update).toHaveBeenCalledWith(
        { sessionId: 'sess-1', status: DeviceLinkSessionStatus.COMPLETED },
        expect.objectContaining({
          status: DeviceLinkSessionStatus.CONSUMED,
          encryptedPayload: null,
          primaryEphemeralPubKey: null,
        }),
      );
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('SESSION_ALREADY_CONSUMED when a concurrent poll already claimed it (affected=0)', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.COMPLETED,
        expiresAt: Date.now() + 60_000,
        primaryUserId: 42,
        primaryEphemeralPubKey: VALID_PUBKEY,
        encryptedPayload: Buffer.from([1, 2, 3, 4]),
        assignedDeviceId: 7,
      });
      sessionRepo.update.mockResolvedValue({ affected: 0 });
      userRepo.findOne.mockResolvedValue(
        makeUser({ id: 42, identityPublicKey: 'identity-key-base64' }),
      );

      await expect(service.getLinkResult('sess-1')).rejects.toMatchObject({
        response: { error: 'SESSION_ALREADY_CONSUMED' },
      });
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

  describe('initLink', () => {
    const mockOpenCount = (count: number) => {
      sessionRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(count),
      } as any);
    };

    it('creates a waiting session and returns sessionId + expiresAt', async () => {
      mockOpenCount(0);

      const result = await service.initLink({
        ephemeralPublicKey: VALID_PUBKEY,
        deviceName: 'iPhone',
        userAgent: 'iOS 18',
      });

      expect(result.sessionId).toEqual(expect.any(String));
      expect(result.sessionId.length).toBeGreaterThan(0);
      expect(result.expiresAt).toEqual(expect.any(String));
      expect(sessionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DeviceLinkSessionStatus.WAITING,
          ephemeralPublicKey: VALID_PUBKEY,
          deviceName: 'iPhone',
        }),
      );
    });

    it('TOO_MANY_LINKS when the global open-session cap is reached', async () => {
      mockOpenCount(1000); // DEFAULT_OPEN_SESSION_CAP

      await expect(
        service.initLink({ ephemeralPublicKey: VALID_PUBKEY }),
      ).rejects.toMatchObject({ response: { error: 'TOO_MANY_LINKS' } });
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('INVALID_EPHEMERAL_KEY for a non-32B key (before touching the DB)', async () => {
      await expect(
        service.initLink({
          ephemeralPublicKey: Buffer.alloc(16).toString('base64'),
        }),
      ).rejects.toMatchObject({ response: { error: 'INVALID_EPHEMERAL_KEY' } });
    });
  });

  describe('completeLink — guards', () => {
    const sharedRow = (over: Record<string, unknown> = {}) => ({
      sessionId: 'sess-1',
      status: DeviceLinkSessionStatus.PUBKEY_SHARED,
      expiresAt: Date.now() + 60_000,
      primaryUserId: 42,
      primaryDeviceId: PRIMARY_DEVICE_ID,
      primaryEphemeralPubKey: VALID_PUBKEY,
      ...over,
    });

    it('DEVICE_LIMIT_REACHED once the user hits the device cap', async () => {
      sessionRepo.findOne.mockResolvedValue(sharedRow());
      deviceRepo.count.mockResolvedValue(5); // DEFAULT_DEVICE_CAP

      await expect(
        service.completeLink(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: VALID_PAYLOAD,
        }),
      ).rejects.toMatchObject({ response: { error: 'DEVICE_LIMIT_REACHED' } });
      expect(deviceRepo.save).not.toHaveBeenCalled();
    });

    it('SESSION_EXPIRED when the TTL elapsed', async () => {
      sessionRepo.findOne.mockResolvedValue(
        sharedRow({ expiresAt: Date.now() - 1_000 }),
      );

      await expect(
        service.completeLink(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: VALID_PAYLOAD,
        }),
      ).rejects.toMatchObject({ response: { error: 'SESSION_EXPIRED' } });
    });

    it('PAYLOAD_TOO_LARGE for an empty payload', async () => {
      await expect(
        service.completeLink(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: '',
        }),
      ).rejects.toMatchObject({ response: { error: 'PAYLOAD_TOO_LARGE' } });
    });

    it('PAYLOAD_TOO_LARGE for a payload over the 4 KB cap', async () => {
      const tooBig = Buffer.alloc(4 * 1024 + 1).toString('base64');

      await expect(
        service.completeLink(42, PRIMARY_DEVICE_ID, {
          sessionId: 'sess-1',
          encryptedPayload: tooBig,
        }),
      ).rejects.toMatchObject({ response: { error: 'PAYLOAD_TOO_LARGE' } });
    });

    it('PRIMARY_REQUIRED if a linked device calls complete', async () => {
      await expect(
        service.completeLink(42, 2, {
          sessionId: 'sess-1',
          encryptedPayload: VALID_PAYLOAD,
        }),
      ).rejects.toMatchObject({ response: { error: 'PRIMARY_REQUIRED' } });
    });
  });

  describe('getLinkResult — guards', () => {
    it('returns the pending shape while the session is still waiting', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.WAITING,
        expiresAt: Date.now() + 60_000,
      });

      expect(await service.getLinkResult('sess-1')).toEqual({
        status: 'pending',
      });
      expect(sessionRepo.save).not.toHaveBeenCalled();
    });

    it('SESSION_ALREADY_CONSUMED on a second poll after completion', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.CONSUMED,
        expiresAt: Date.now() + 60_000,
        consumedAt: Date.now(),
      });

      await expect(service.getLinkResult('sess-1')).rejects.toMatchObject({
        response: { error: 'SESSION_ALREADY_CONSUMED' },
      });
    });

    it('SESSION_EXPIRED once the TTL has elapsed', async () => {
      sessionRepo.findOne.mockResolvedValue({
        sessionId: 'sess-1',
        status: DeviceLinkSessionStatus.PUBKEY_SHARED,
        expiresAt: Date.now() - 1_000,
      });

      await expect(service.getLinkResult('sess-1')).rejects.toMatchObject({
        response: { error: 'SESSION_EXPIRED' },
      });
    });

    it('SESSION_NOT_FOUND for an unknown sessionId', async () => {
      sessionRepo.findOne.mockResolvedValue(null);

      await expect(service.getLinkResult('nope')).rejects.toMatchObject({
        response: { error: 'SESSION_NOT_FOUND' },
      });
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('soft-expires waiting rows and hard-deletes lapsed AND consumed rows', async () => {
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3 }),
      };
      sessionRepo.createQueryBuilder.mockReturnValue(qb as any);
      sessionRepo.delete.mockResolvedValue({ affected: 0 } as any);

      const expired = await service.cleanupExpiredSessions();

      expect(expired).toBe(3);
      // Two disjoint hard-delete passes: never-consumed lapsed + consumed.
      expect(sessionRepo.delete).toHaveBeenCalledTimes(2);
      expect(sessionRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          status: DeviceLinkSessionStatus.CONSUMED,
        }),
      );
    });
  });

  describe('isDeviceRevoked (cached)', () => {
    it('returns true for a revoked device and serves repeats from cache', async () => {
      deviceRepo.find.mockResolvedValue([{ userId: 42, deviceId: 2 }]);

      expect(await service.isDeviceRevoked(42, 2)).toBe(true);
      expect(await service.isDeviceRevoked(42, 3)).toBe(false);
      // Both lookups served by a single DB load (within the TTL).
      expect(deviceRepo.find).toHaveBeenCalledTimes(1);
    });

    it('markDeviceRevokedInCache takes effect without a DB reload', async () => {
      deviceRepo.find.mockResolvedValue([]);

      expect(await service.isDeviceRevoked(42, 2)).toBe(false); // loads cache
      service.markDeviceRevokedInCache(42, 2);
      expect(await service.isDeviceRevoked(42, 2)).toBe(true);
      expect(deviceRepo.find).toHaveBeenCalledTimes(1);
    });
  });
});
