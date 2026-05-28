import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { RoomUser } from '../../../entities/room-user.entity';
import { PushToken } from '../../../entities/push-token.entity';
import { PendingMessage } from '../../../entities/pending-message.entity';
import { ExpoNotificationService } from '../../../services/expo-notification.service';
import { PushRelayService } from '../../../services/push-relay.service';
import { CloudWorkerConfigService } from '../../../config/cloud-worker/config.service';
import { RoomService } from './room.service';
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

// Keep `emitWithAck` timeouts short so the fire-and-forget background
// deliveries (backend-0015) drain quickly during tests. Set BEFORE the
// service is constructed in `beforeEach` (field initializer reads env).
const ORIGINAL_ACK_TIMEOUT = process.env.ACK_TIMEOUT_MS;
beforeAll(() => {
  process.env.ACK_TIMEOUT_MS = '50';
});
afterAll(() => {
  if (ORIGINAL_ACK_TIMEOUT === undefined) {
    delete process.env.ACK_TIMEOUT_MS;
  } else {
    process.env.ACK_TIMEOUT_MS = ORIGINAL_ACK_TIMEOUT;
  }
});

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
  let roomService: { getActiveDevices: jest.Mock };

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
    // Default: return one device per `(userId)` from the roomUserRepo `.find`
    // mock — tests that need a richer device set override per-call.
    roomService = {
      getActiveDevices: jest.fn().mockImplementation(async () => {
        const rows = (await roomUserRepo.find({})) ?? [];
        return rows.map((ru: { userId: number }) => ({
          userId: ru.userId,
          deviceId: 1,
        }));
      }),
    };

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
        { provide: RoomService, useValue: roomService },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    service.setServer(mockServer as any);

    // Stop cleanup interval to avoid open handles
    service.onModuleDestroy();
  });

  describe('normalizeEnvelope', () => {
    it('should generate UUID and timestamp', () => {
      const envelope = service.normalizeEnvelope(1, 2, 1, { text: 'hello' });

      expect(envelope.id).toBeDefined();
      expect(envelope.id).toHaveLength(36); // UUID format
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.roomId).toBe(1);
      expect(envelope.senderId).toBe(2);
      expect(envelope.senderDeviceId).toBe(1);
      expect(envelope.message).toEqual({ text: 'hello' });
    });

    it('should use default category and type if not provided', () => {
      const envelope = service.normalizeEnvelope(1, 2, 1, {});

      expect(envelope.category).toBe('message');
      expect(envelope.type).toBe('text');
    });

    it('should use provided category and type', () => {
      const envelope = service.normalizeEnvelope(
        1,
        2,
        1,
        {},
        'control',
        'session',
      );

      expect(envelope.category).toBe('control');
      expect(envelope.type).toBe('session');
    });

    it('should forward the senderDeviceId from auth context', () => {
      const envelope = service.normalizeEnvelope(1, 2, 7, { text: 'hello' });
      expect(envelope.senderDeviceId).toBe(7);
    });

    // backend-0016: honour a client-minted id so the sender can correlate
    // delivered/read receipts back to its local optimistic row.
    it('should use the client-minted id when provided', () => {
      const clientId = '11111111-2222-3333-4444-555555555555';
      const envelope = service.normalizeEnvelope(
        1,
        2,
        1,
        { text: 'hello' },
        undefined,
        undefined,
        clientId,
      );
      expect(envelope.id).toBe(clientId);
    });
  });

  describe('sendToRoom', () => {
    it('non-volatile: acks immediately, runs delivery + pending in the background (backend-0015)', async () => {
      // Recipient socket that never acks. With the old coupled impl this
      // would have made `sendToRoom` resolve only after ACK_TIMEOUT and the
      // pending-row would already be written by the time `await` returns.
      const zombie = {
        id: 'zombie',
        user: { userId: 2, deviceId: 1 },
        emit: jest.fn(), // never invokes ack callback
      };
      mockServer._setSockets([zombie]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const start = Date.now();
      const result = await service.sendToRoom(1, 1, 1, { text: 'hello' });
      const elapsed = Date.now() - start;

      // The relay has accepted for routing — sender is acked now.
      expect(result.id).toBeDefined();
      expect(result.delivered).toBe(true);
      expect(elapsed).toBeLessThan(500); // criterion 1: <500ms even with zombie

      // Decoupling proof: the pending-row write hasn't happened yet — it
      // runs in the background after ACK_TIMEOUT (coupled impl would have
      // already called `create`).
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();

      // …and once the background drains, the offline recipient lands in
      // pending_messages as before.
      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 2, roomId: 1 }),
      );
    });

    it('non-volatile: emits to acking recipient in the background', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const result = await service.sendToRoom(1, 1, 1, { text: 'hello' });
      expect(result.delivered).toBe(true); // accepted for relay
      expect(result.senderDeviceId).toBe(1);

      await service.awaitBackgroundDeliveries();
      expect(socket.emit).toHaveBeenCalledWith(
        'newMessage',
        expect.objectContaining({ message: { text: 'hello' } }),
        expect.any(Function),
      );
      // Acking recipient → no pending row.
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('non-volatile: saves pending for users who never see a socket', async () => {
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      await service.sendToRoom(1, 1, 1, { text: 'hello' });
      await service.awaitBackgroundDeliveries();

      expect(pendingMessageRepo.create).toHaveBeenCalled();
      expect(pendingMessageRepo.save).toHaveBeenCalled();
    });

    it('volatile: stays synchronous and returns the real delivered flag', async () => {
      // Volatile sends have no offline queue, so the sender needs the real
      // `delivered` value (drives volatile-image UNDELIVERED on the client).
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);

      const delivered = await service.sendToRoom(
        1,
        1,
        1,
        { text: 'hello' },
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(delivered.delivered).toBe(true);

      mockServer._setSockets([]);
      const notDelivered = await service.sendToRoom(
        1,
        1,
        1,
        { text: 'hello' },
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(notDelivered.delivered).toBe(false);
    });

    it('volatile: skips the offline queue', async () => {
      mockServer._setSockets([]);

      await service.sendToRoom(
        1,
        1,
        1,
        { text: 'hello' },
        undefined,
        undefined,
        undefined,
        true,
      );

      // No background scheduled, no pending row.
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('sendControlPacket', () => {
    it('acks the sender without waiting for a non-acking recipient (backend-0015)', async () => {
      // Reproduces the desktop-0014 / signal-chat-protocol-expert diagnosis:
      // a recipient socket that never invokes the ack callback used to add
      // ACK_TIMEOUT to every sender's latency for every control packet.
      const zombie = {
        id: 'zombie',
        user: { userId: 2, deviceId: 1 },
        emit: jest.fn(),
      };
      mockServer._setSockets([zombie]);

      const start = Date.now();
      const packet = await service.sendControlPacket(
        1,
        1,
        1,
        { type: 'READ' },
        [2],
      );
      const elapsed = Date.now() - start;

      expect(packet.id).toBeDefined();
      expect(packet.recipientIds).toEqual([2]);
      expect(elapsed).toBeLessThan(500); // criterion 1: <500ms

      // The pending-row write hasn't happened yet (decoupling proof).
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 2, roomId: 1 }),
      );
    });

    it('per-user sockets are emitted in parallel — a dead socket cannot gate the live one', async () => {
      const zombie = {
        id: 'sock-zombie',
        user: { userId: 2, deviceId: 1 },
        emit: jest.fn(), // never acks
      };
      const live = {
        id: 'sock-live',
        user: { userId: 2, deviceId: 1 },
        emit: jest
          .fn()
          .mockImplementation(
            (_event, _data, ack?: () => void) => ack && ack(),
          ),
      };
      mockServer._setSockets([zombie, live]);

      const packet = await service.sendControlPacket(
        1,
        1,
        1,
        { type: 'READ' },
        [2],
      );
      expect(packet.id).toBeDefined();

      await service.awaitBackgroundDeliveries();
      // Both sockets received the emit (parallel fan-out).
      expect(zombie.emit).toHaveBeenCalled();
      expect(live.emit).toHaveBeenCalled();
      // Live socket acked → no pending row queued for user 2.
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('sends to specific recipientIds', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);

      const packet = await service.sendControlPacket(
        1,
        1,
        1,
        { type: 'SESSION_ESTABLISHED' },
        [2],
      );

      expect(packet.id).toBeDefined();
      expect(packet.roomId).toBe(1);
      expect(packet.recipientIds).toEqual([2]);
      expect(packet.senderDeviceId).toBe(1);

      await service.awaitBackgroundDeliveries();
      expect(socket.emit).toHaveBeenCalledWith(
        'newPacket',
        expect.objectContaining({ packet: { type: 'SESSION_ESTABLISHED' } }),
        expect.any(Function),
      );
    });

    it('broadcasts to the entire room when recipientIds is omitted', async () => {
      const socket = mockServer._mockSocket(2, 'sock-2');
      mockServer._setSockets([socket]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const packet = await service.sendControlPacket(1, 1, 1, {
        type: 'TYPING',
      });

      expect(packet.id).toBeDefined();
      await service.awaitBackgroundDeliveries();
      expect(socket.emit).toHaveBeenCalledWith(
        'newPacket',
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('skips the offline queue for volatile control packets', async () => {
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);

      await service.sendControlPacket(
        1,
        1,
        1,
        { type: 'TYPING' },
        undefined,
        undefined,
        true,
      );

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('skips the offline queue for volatile control packets with recipientIds', async () => {
      // No sockets for user 2 → would normally queue, but volatile must not.
      mockServer._setSockets([]);

      await service.sendControlPacket(
        1,
        1,
        1,
        { type: 'TYPING' },
        [2],
        undefined,
        true,
      );

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('returns early if server is not initialized', async () => {
      service.setServer(undefined as any);

      const packet = await service.sendControlPacket(1, 1, 1, {
        type: 'test',
      });

      expect(packet.id).toBeDefined();
      // No crash, no socket operations
    });
  });

  describe('handleOfflineUsers', () => {
    it("saves a per-device pending row for every active device that didn't ack", async () => {
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 2, deviceId: 1 },
        { userId: 3, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      // user 2 device 1 acked; user 3 device 1 is offline.
      await service.handleOfflineUsers(1, 1, 1, envelope, new Set(['2:1']));

      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 3,
          roomId: 1,
          recipientDeviceId: 1,
        }),
      );
    });

    it("queues per-device pending for the sender's OTHER device (backend-0011)", async () => {
      // Sender = user 1 device 1. User 1 also has device 2 offline.
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 1, deviceId: 2 },
        { userId: 2, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([]);

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, 1, envelope, new Set(['2:1']));

      // Only user 1 device 2 needs a pending row — the sending device is excluded.
      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          roomId: 1,
          recipientDeviceId: 2,
        }),
      );
    });

    it('sends a push to offline non-sender users', async () => {
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 2, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, 1, envelope, new Set());

      expect(expoNotificationService.sendNotification).toHaveBeenCalled();
    });

    it("never pushes the sender — even when sender's other device is offline", async () => {
      // Sender's other device is offline; non-self user 2 has no offline device.
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 1, deviceId: 2 },
        { userId: 2, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 1 })]);

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      // User 2 device 1 acked → only the sender's other device is offline.
      await service.handleOfflineUsers(1, 1, 1, envelope, new Set(['2:1']));

      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('skips push with skipNotification=true', async () => {
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 2, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      await service.handleOfflineUsers(1, 1, 1, envelope, new Set(), true);

      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('does not throw if push notification fails', async () => {
      roomService.getActiveDevices.mockResolvedValue([
        { userId: 1, deviceId: 1 },
        { userId: 2, deviceId: 1 },
      ]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);
      expoNotificationService.sendNotification.mockRejectedValue(
        new Error('Push failed'),
      );

      const envelope = service.normalizeEnvelope(1, 1, 1, { text: 'test' });
      await expect(
        service.handleOfflineUsers(1, 1, 1, envelope, new Set()),
      ).resolves.toBeUndefined();
    });
  });

  describe('fanOutToRecipients', () => {
    const makeDeviceSocket = (
      userId: number,
      deviceId: number,
      socketId: string,
      autoAck = true,
    ) => ({
      id: socketId,
      user: { userId, deviceId },
      emit: jest
        .fn()
        .mockImplementation((_event: string, _data: any, ack?: () => void) => {
          if (autoAck && ack) ack();
        }),
    });

    it('delivers a different ciphertext per (userId, deviceId)', async () => {
      const sockA1 = makeDeviceSocket(2, 1, 'sock-A1');
      const sockA2 = makeDeviceSocket(2, 2, 'sock-A2');
      mockServer._setSockets([sockA1, sockA2]);

      const result = await service.fanOutToRecipients(
        1,
        1,
        1,
        [
          { userId: 2, deviceId: 1, ciphertext: 'ct-1' },
          { userId: 2, deviceId: 2, ciphertext: 'ct-2' },
        ],
        undefined,
        undefined,
      );

      // Accepted for relay (non-volatile decouples, backend-0015).
      expect(result.delivered).toBe(true);
      expect(result.messageId).toBeDefined();

      await service.awaitBackgroundDeliveries();
      expect(sockA1.emit).toHaveBeenCalledWith(
        'newMessage',
        expect.objectContaining({ message: 'ct-1' }),
        expect.any(Function),
      );
      expect(sockA2.emit).toHaveBeenCalledWith(
        'newMessage',
        expect.objectContaining({ message: 'ct-2' }),
        expect.any(Function),
      );
    });

    it('queues per-device pending for offline targets', async () => {
      // Only device 1 is online; device 2 is offline.
      const sockA1 = makeDeviceSocket(2, 1, 'sock-A1');
      mockServer._setSockets([sockA1]);
      pushTokenRepo.find.mockResolvedValue([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);

      await service.fanOutToRecipients(
        1,
        1,
        1,
        [
          { userId: 2, deviceId: 1, ciphertext: 'ct-1' },
          { userId: 2, deviceId: 2, ciphertext: 'ct-2' },
        ],
        undefined,
        undefined,
      );

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 2,
          roomId: 1,
          recipientDeviceId: 2,
        }),
      );
    });

    it('pushes when at least one device of a non-self user is offline', async () => {
      mockServer._setSockets([]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);

      await service.fanOutToRecipients(
        1,
        1, // sender
        1,
        [
          { userId: 2, deviceId: 1, ciphertext: 'ct-1' },
          { userId: 2, deviceId: 2, ciphertext: 'ct-2' },
        ],
        undefined,
        undefined,
      );

      await service.awaitBackgroundDeliveries();
      expect(expoNotificationService.sendNotification).toHaveBeenCalledTimes(1);
      const [tokens] = expoNotificationService.sendNotification.mock.calls[0];
      expect(tokens).toEqual([expect.any(String)]);
    });

    it('does NOT push the sender even if their other devices are offline', async () => {
      mockServer._setSockets([]);
      // Sender user 1 has push tokens for their own devices.
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 1 })]);
      roomUserRepo.find.mockResolvedValue([makeRoomUser({ userId: 1 })]);

      await service.fanOutToRecipients(
        1,
        1, // sender
        1,
        [{ userId: 1, deviceId: 2, ciphertext: 'self-ct' }],
        undefined,
        undefined,
      );

      await service.awaitBackgroundDeliveries();
      // pendingMessageRepo was hit (offline self-device) but push must NOT
      // — Signal/WhatsApp semantics: don't self-notify across our own devices.
      expect(pendingMessageRepo.create).toHaveBeenCalledTimes(1);
      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('volatile fan-out stays synchronous, skips queue + push, real delivered', async () => {
      mockServer._setSockets([]);

      const result = await service.fanOutToRecipients(
        1,
        1,
        1,
        [{ userId: 2, deviceId: 1, ciphertext: 'ct-1' }],
        undefined,
        undefined,
        undefined,
        true, // volatile
      );

      // Volatile path returns the *real* delivered (no offline queue exists).
      expect(result.delivered).toBe(false);
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    // backend-0016: client-minted id flows to every recipient envelope so
    // receipts (id_message = envelope.id) correlate to the sender's local row.
    it('uses the client-minted id as baseId on every fan-out envelope', async () => {
      const sockA1 = makeDeviceSocket(2, 1, 'sock-A1');
      const sockA2 = makeDeviceSocket(2, 2, 'sock-A2');
      mockServer._setSockets([sockA1, sockA2]);
      const clientId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      const result = await service.fanOutToRecipients(
        1,
        1,
        1,
        [
          { userId: 2, deviceId: 1, ciphertext: 'ct-1' },
          { userId: 2, deviceId: 2, ciphertext: 'ct-2' },
        ],
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        clientId,
      );

      expect(result.messageId).toBe(clientId);

      await service.awaitBackgroundDeliveries();
      expect(sockA1.emit).toHaveBeenCalledWith(
        'newMessage',
        expect.objectContaining({ id: clientId, message: 'ct-1' }),
        expect.any(Function),
      );
      expect(sockA2.emit).toHaveBeenCalledWith(
        'newMessage',
        expect.objectContaining({ id: clientId, message: 'ct-2' }),
        expect.any(Function),
      );
    });

    it('does NOT queue or push a recipient who is not a room member', async () => {
      mockServer._setSockets([]); // everyone offline
      // Room contains only the sender (user 1); user 99 is NOT a member.
      roomUserRepo.find.mockResolvedValue([makeRoomUser({ userId: 1 })]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 99 })]);

      await service.fanOutToRecipients(
        1,
        1, // sender
        1,
        [{ userId: 99, deviceId: 1, ciphertext: 'evil' }],
        undefined,
        undefined,
      );

      await service.awaitBackgroundDeliveries();
      // A non-member must get neither a pending row nor a push.
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe('fanOutPacketToRecipients', () => {
    const makeDeviceSocket = (
      userId: number,
      deviceId: number,
      socketId: string,
    ) => ({
      id: socketId,
      user: { userId, deviceId },
      emit: jest
        .fn()
        .mockImplementation((_event: string, _data: any, ack?: () => void) => {
          if (ack) ack();
        }),
    });

    it('routes one packet per (userId, deviceId) and never pushes', async () => {
      const sockB1 = makeDeviceSocket(2, 1, 'sock-B1');
      const sockB2 = makeDeviceSocket(2, 2, 'sock-B2');
      mockServer._setSockets([sockB1, sockB2]);
      pushTokenRepo.find.mockResolvedValue([makePushToken({ userId: 2 })]);

      const result = await service.fanOutPacketToRecipients(1, 1, 1, [
        { userId: 2, deviceId: 1, packet: { type: 'X3DH', for: 1 } },
        { userId: 2, deviceId: 2, packet: { type: 'X3DH', for: 2 } },
      ]);

      // Control packets always decouple (backend-0015): `delivered: true` =
      // accepted for relay; the per-device emits run in the background.
      expect(result.delivered).toBe(true);
      expect(result.packetId).toBeDefined();

      await service.awaitBackgroundDeliveries();
      expect(sockB1.emit).toHaveBeenCalledWith(
        'newPacket',
        expect.objectContaining({ packet: { type: 'X3DH', for: 1 } }),
        expect.any(Function),
      );
      expect(sockB2.emit).toHaveBeenCalledWith(
        'newPacket',
        expect.objectContaining({ packet: { type: 'X3DH', for: 2 } }),
        expect.any(Function),
      );
      expect(expoNotificationService.sendNotification).not.toHaveBeenCalled();
    });

    it('queues per-device pending for offline targets', async () => {
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([
        makeRoomUser({ userId: 1 }),
        makeRoomUser({ userId: 2 }),
      ]);

      await service.fanOutPacketToRecipients(1, 1, 1, [
        { userId: 2, deviceId: 7, packet: { type: 'X3DH' } },
      ]);

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 2,
          roomId: 1,
          recipientDeviceId: 7,
        }),
      );
    });

    it('skips offline queue when volatile', async () => {
      mockServer._setSockets([]);

      await service.fanOutPacketToRecipients(
        1,
        1,
        1,
        [{ userId: 2, deviceId: 1, packet: { type: 'TYPING' } }],
        undefined,
        true,
      );

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
    });

    it('does NOT queue a control packet for a non-member recipient', async () => {
      mockServer._setSockets([]);
      roomUserRepo.find.mockResolvedValue([makeRoomUser({ userId: 1 })]);

      await service.fanOutPacketToRecipients(1, 1, 1, [
        { userId: 99, deviceId: 1, packet: { type: 'X3DH' } },
      ]);

      await service.awaitBackgroundDeliveries();
      expect(pendingMessageRepo.create).not.toHaveBeenCalled();
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
          .mockImplementation(
            (_event: string, _data: any, ack?: () => void) => {
              if (ack) ack();
            },
          ),
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
