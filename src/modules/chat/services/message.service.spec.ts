import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { RoomUser } from '../../../entities/room-user.entity';
import { PushToken } from '../../../entities/push-token.entity';
import { PendingMessage } from '../../../entities/pending-message.entity';
import { ExpoNotificationService } from '../../../services/expo-notification.service';
import { PushRelayService } from '../../../services/push-relay.service';
import { CloudWorkerConfigService } from '../../../config/cloud-worker/config.service';
import {
  createMockRepository,
  createMockSocketServer,
  makeRoomUser,
  makePendingMessage,
  makePushToken,
} from '../../../test/helpers';

// Mock deployment-mode to always be cloud (not selfhosted) so push goes to Expo
jest.mock('../../../config/deployment-mode', () => ({
  isSelfHostedMode: jest.fn().mockReturnValue(false),
  isCloudMode: jest.fn().mockReturnValue(true),
  DEPLOYMENT_MODE: 'cloud',
  DeploymentMode: { CLOUD: 'cloud', SELFHOSTED: 'selfhosted' },
}));

describe('MessageService', () => {
  let service: MessageService;
  let roomUserRepo: ReturnType<typeof createMockRepository>;
  let pushTokenRepo: ReturnType<typeof createMockRepository>;
  let pendingMessageRepo: ReturnType<typeof createMockRepository>;
  let expoNotificationService: { sendNotification: jest.Mock };
  let pushRelayService: {
    sendNotification: jest.Mock;
    isConfigured: jest.Mock;
  };
  let cloudWorkerConfig: { pushIncludeData: boolean };
  let mockServer: ReturnType<typeof createMockSocketServer>;

  beforeEach(async () => {
    roomUserRepo = createMockRepository();
    pushTokenRepo = createMockRepository();
    pendingMessageRepo = createMockRepository();
    expoNotificationService = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    pushRelayService = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
      isConfigured: jest.fn().mockReturnValue(false),
    };
    cloudWorkerConfig = { pushIncludeData: false };
    mockServer = createMockSocketServer();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: getRepositoryToken(RoomUser), useValue: roomUserRepo },
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        {
          provide: getRepositoryToken(PendingMessage),
          useValue: pendingMessageRepo,
        },
        { provide: ExpoNotificationService, useValue: expoNotificationService },
        { provide: PushRelayService, useValue: pushRelayService },
        { provide: CloudWorkerConfigService, useValue: cloudWorkerConfig },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    service.setServer(mockServer as any);

    // Stop cleanup interval to avoid open handles
    service.onModuleDestroy();
  });

  describe('normalizeEnvelope', () => {
    it('should generate UUID and timestamp', () => {
      const envelope = service.normalizeEnvelope(1, 2, { text: 'hello' });

      expect(envelope.id).toBeDefined();
      expect(envelope.id).toHaveLength(36); // UUID format
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.roomId).toBe(1);
      expect(envelope.senderId).toBe(2);
      expect(envelope.message).toEqual({ text: 'hello' });
    });

    it('should use default category and type if not provided', () => {
      const envelope = service.normalizeEnvelope(1, 2, {});

      expect(envelope.category).toBe('message');
      expect(envelope.type).toBe('text');
    });

    it('should use provided category and type', () => {
      const envelope = service.normalizeEnvelope(
        1,
        2,
        {},
        'control',
        'session',
      );

      expect(envelope.category).toBe('control');
      expect(envelope.type).toBe('session');
    });
  });

  describe('sendToRoom', () => {
    it('should deliver with ack and return delivered=true when recipients ack', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);

      const result = await service.sendToRoom(1, 1, { text: 'hello' });

      expect(result.delivered).toBe(true);
      expect(result.id).toBeDefined();
      expect(result.roomId).toBe(1);
    });

    it('should return delivered=false when no recipients are in room', async () => {
      mockServer._setSockets([]);

      const result = await service.sendToRoom(1, 1, { text: 'hello' });

      expect(result.delivered).toBe(false);
    });

    it('should save pending for offline users when not volatile', async () => {
      // No sockets in room = all offline
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      await service.sendToRoom(1, 1, { text: 'hello' });

      expect(pendingMessageRepo.create).toHaveBeenCalled();
      expect(pendingMessageRepo.save).toHaveBeenCalled();
    });

    it('should skip offline queue for volatile messages', async () => {
      mockServer._setSockets([]);

      await service.sendToRoom(
        1,
        1,
        { text: 'hello' },
        undefined,
        undefined,
        undefined,
        true,
      );

      // handleOfflineUsers should NOT be called for volatile
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('sendControlPacket', () => {
    it('should send to specific recipientIds', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);

      const packet = await service.sendControlPacket(
        1,
        1,
        { type: 'SESSION_ESTABLISHED' },
        [2],
      );

      expect(packet.id).toBeDefined();
      expect(packet.roomId).toBe(1);
      expect(packet.recipientIds).toEqual([2]);
    });

    it('should broadcast to entire room when recipientIds not specified', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const packet = await service.sendControlPacket(1, 1, { type: 'TYPING' });

      expect(packet.id).toBeDefined();
    });

    it('should skip offline queue for volatile control packets', async () => {
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);

      await service.sendControlPacket(
        1,
        1,
        { type: 'TYPING' },
        undefined,
        undefined,
        true,
      );

      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('should return early if server is not initialized', async () => {
      service.setServer(undefined as any);

      const packet = await service.sendControlPacket(1, 1, { type: 'test' });

      expect(packet.id).toBeDefined();
      // No crash, no socket operations
    });
  });

  describe('handleOfflineUsers', () => {
    it('should save pending for users not in ackedUserIds', async () => {
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
        makeRoomUser({ userId: 3 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const envelope = service.normalizeEnvelope(1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, envelope, [2]); // userId 3 is offline

      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 3, roomId: 1 }),
      );
    });

    it('should send push notification to offline users', async () => {
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);

      const envelope = service.normalizeEnvelope(1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, envelope, []);

      expect(expoNotificationService.sendNotification).toHaveBeenCalled();
    });

    it('should skip push with skipNotification=true', async () => {
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);

      const envelope = service.normalizeEnvelope(1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, envelope, [], true);

      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('should not throw if push notification fails', async () => {
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);
      expoNotificationService.sendNotification.mockRejectedValue(
        new Error('Push failed'),
      );

      const envelope = service.normalizeEnvelope(1, 1, { text: 'test' });

      // Should not throw
      await expect(
        service.handleOfflineUsers(1, 1, envelope, []),
      ).resolves.toBeUndefined();
    });
  });

  describe('deliverPendingToSocket', () => {
    it('should deliver pending messages and delete after ack', async () => {
      const pending = makePendingMessage({
        id: 'msg-1',
        envelope: JSON.stringify({
          id: 'msg-1',
          roomId: 1,
          senderId: 2,
          message: { text: 'hi' },
          timestamp: new Date().toISOString(),
        }),
      });

      pendingMessageRepo.find.mockResolvedValue([pending]);

      // Socket that acks
      const socket = {
        emit: jest
          .fn()
          .mockImplementation((_event: string, _data: any, ack?: Function) => {
            if (ack) ack();
          }),
      };

      const count = await service.deliverPendingToSocket(1, 1, socket);

      expect(count).toBe(1);
      expect(pendingMessageRepo.delete).toHaveBeenCalledWith({ id: 'msg-1' });
    });

    it('should keep pending if client does not ack', async () => {
      const pending = makePendingMessage({
        id: 'msg-1',
        envelope: JSON.stringify({
          id: 'msg-1',
          roomId: 1,
          senderId: 2,
          message: { text: 'hi' },
          timestamp: new Date().toISOString(),
        }),
      });

      pendingMessageRepo.find.mockResolvedValue([pending]);

      // Socket that does NOT ack (zombie)
      const socket = {
        emit: jest.fn(), // No callback invocation
      };

      const count = await service.deliverPendingToSocket(1, 1, socket);

      expect(count).toBe(0);
      expect(pendingMessageRepo.delete).not.toHaveBeenCalled();
    }, 10000);

    it('should return 0 when no pending messages exist', async () => {
      pendingMessageRepo.find.mockResolvedValue([]);

      const socket = { emit: jest.fn() };
      const count = await service.deliverPendingToSocket(1, 1, socket);

      expect(count).toBe(0);
    });
  });
});
