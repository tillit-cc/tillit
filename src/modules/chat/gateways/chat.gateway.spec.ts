import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { MessageService } from '../services/message.service';
import { RoomService } from '../services/room.service';
import { SenderKeysService } from '../../sender-keys/services/sender-keys.service';
import { DeviceLinkService } from '../../../auth/services/device-link.service';
import { DeviceService } from '../../../auth/services/device.service';
import { AuthService } from '../../../auth/auth.service';
import { RedisConfigService } from '../../../config/database/redis/config.service';
import { ChatEvents } from '../interfaces/chat-events';
import { makeRoom, makeMockClient } from '../../../test/helpers';

// Mock libsignal-client (native ESM addon) — pulled in transitively via
// AuthService, which the gateway now injects for the liveness lock.
jest.mock('@signalapp/libsignal-client', () => ({
  PublicKey: {
    deserialize: jest.fn().mockReturnValue({
      verify: jest.fn().mockReturnValue(true),
    }),
  },
}));

// Mock deployment mode to selfhosted (skip Redis adapter)
jest.mock('../../../config/deployment-mode', () => ({
  isCloudMode: jest.fn().mockReturnValue(false),
  isSelfHostedMode: jest.fn().mockReturnValue(true),
  DEPLOYMENT_MODE: 'selfhosted',
  DeploymentMode: { CLOUD: 'cloud', SELFHOSTED: 'selfhosted' },
}));

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let messageService: {
    setServer: jest.Mock;
    sendToRoom: jest.Mock;
    sendControlPacket: jest.Mock;
    deliverPendingToSocket: jest.Mock;
    broadcastToRoomMembers: jest.Mock;
    deliverEnvelopeToRoom: jest.Mock;
    fanOutToRecipients: jest.Mock;
    fanOutPacketToRecipients: jest.Mock;
  };
  let roomService: {
    getUserRooms: jest.Mock;
    isUserInRoom: jest.Mock;
    getRoomById: jest.Mock;
    getPeerUserIds: jest.Mock;
  };
  let senderKeysService: {
    setServer: jest.Mock;
    getPendingSenderKeys: jest.Mock;
  };
  let deviceLinkService: { setNotifier: jest.Mock; isDeviceRevoked: jest.Mock };
  let deviceService: { setNotifier: jest.Mock };
  let authService: {
    refreshPrimaryLiveness: jest.Mock;
    assertPrimaryActive: jest.Mock;
  };

  beforeEach(async () => {
    messageService = {
      setServer: jest.fn(),
      sendToRoom: jest.fn().mockResolvedValue({
        id: 'msg-1',
        delivered: true,
        timestamp: new Date().toISOString(),
      }),
      sendControlPacket: jest.fn().mockResolvedValue({
        id: 'pkt-1',
        timestamp: new Date().toISOString(),
      }),
      deliverPendingToSocket: jest.fn().mockResolvedValue(0),
      broadcastToRoomMembers: jest.fn(),
      deliverEnvelopeToRoom: jest.fn().mockResolvedValue({
        delivered: true,
        ackedDeviceKeys: new Set<string>(),
      }),
      fanOutToRecipients: jest.fn().mockResolvedValue({
        delivered: true,
        messageId: 'msg-fan-1',
        timestamp: new Date().toISOString(),
      }),
      fanOutPacketToRecipients: jest.fn().mockResolvedValue({
        delivered: true,
        packetId: 'pkt-fan-1',
        timestamp: new Date().toISOString(),
      }),
    };

    roomService = {
      getUserRooms: jest.fn().mockResolvedValue([]),
      isUserInRoom: jest.fn().mockResolvedValue(true),
      getRoomById: jest.fn(),
      getPeerUserIds: jest.fn().mockResolvedValue([]),
    };

    senderKeysService = {
      setServer: jest.fn(),
      getPendingSenderKeys: jest.fn().mockResolvedValue([]),
    };

    deviceLinkService = {
      setNotifier: jest.fn(),
      isDeviceRevoked: jest.fn().mockResolvedValue(false),
    };
    deviceService = {
      setNotifier: jest.fn(),
    };

    authService = {
      refreshPrimaryLiveness: jest.fn().mockResolvedValue(undefined),
      assertPrimaryActive: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: MessageService, useValue: messageService },
        { provide: RoomService, useValue: roomService },
        { provide: SenderKeysService, useValue: senderKeysService },
        { provide: DeviceLinkService, useValue: deviceLinkService },
        { provide: DeviceService, useValue: deviceService },
        { provide: AuthService, useValue: authService },
        { provide: RedisConfigService, useValue: undefined },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
  });

  describe('afterInit', () => {
    it('should set server on messageService and senderKeysService', async () => {
      const mockServer = { adapter: jest.fn() } as any;

      await gateway.afterInit(mockServer);

      expect(messageService.setServer).toHaveBeenCalledWith(mockServer);
      expect(senderKeysService.setServer).toHaveBeenCalledWith(mockServer);
    });

    it('wires notifyPeersDeviceLinked to fan-out peerDeviceLinked to each peer user room', async () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const mockServer = { adapter: jest.fn(), to } as any;
      roomService.getPeerUserIds.mockResolvedValue([101, 102]);

      await gateway.afterInit(mockServer);
      const notifier = deviceLinkService.setNotifier.mock.calls[0][0];

      const linkedAt = '2026-05-21T12:00:00.000Z';
      await notifier.notifyPeersDeviceLinked(42, 2, linkedAt);

      expect(roomService.getPeerUserIds).toHaveBeenCalledWith(42);
      expect(to).toHaveBeenCalledWith('user:101');
      expect(to).toHaveBeenCalledWith('user:102');
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledWith(ChatEvents.PeerDeviceLinked, {
        userId: 42,
        addedDeviceId: 2,
        linkedAt,
      });
      // Must NOT broadcast to the linked user itself — they get `deviceLinked`.
      expect(to).not.toHaveBeenCalledWith('user:42');
    });

    it('notifyPeersDeviceLinked is a no-op when the linked user has no peers', async () => {
      const emit = jest.fn();
      const to = jest.fn().mockReturnValue({ emit });
      const mockServer = { adapter: jest.fn(), to } as any;
      roomService.getPeerUserIds.mockResolvedValue([]);

      await gateway.afterInit(mockServer);
      const notifier = deviceLinkService.setNotifier.mock.calls[0][0];

      await notifier.notifyPeersDeviceLinked(42, 2, '2026-05-21T12:00:00.000Z');

      expect(to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('handleConnection', () => {
    it('should auto-join user rooms and deliver pending messages', async () => {
      const room = makeRoom({ id: 1, useSenderKeys: false });
      roomService.getUserRooms.mockResolvedValue([room]);

      const client = makeMockClient(1) as any;

      await gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('user:1');
      expect(client.join).toHaveBeenCalledWith('room:1');
      expect(messageService.deliverPendingToSocket).toHaveBeenCalledWith(
        1,
        1,
        client,
        1,
      );
    });

    it('should join personal room user:{userId}', async () => {
      roomService.getUserRooms.mockResolvedValue([]);
      const client = makeMockClient(5) as any;

      await gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('user:5');
    });

    it('should notify sender-key rooms with userOnline', async () => {
      const room = makeRoom({ id: 2, useSenderKeys: true });
      roomService.getUserRooms.mockResolvedValue([room]);

      const mockEmit = jest.fn();
      const mockExcept = jest.fn().mockReturnValue({ emit: mockEmit });
      const mockTo = jest.fn().mockReturnValue({ except: mockExcept });
      gateway.server = { to: mockTo } as any;

      const client = makeMockClient(1, 'sock-1') as any;

      await gateway.handleConnection(client);

      expect(mockTo).toHaveBeenCalledWith('room:2');
      expect(mockExcept).toHaveBeenCalledWith('sock-1');
      expect(mockEmit).toHaveBeenCalledWith(
        ChatEvents.UserOnline,
        expect.objectContaining({ userId: 1, roomId: 2 }),
      );
    });

    it('should not crash if userId is undefined', async () => {
      const client = makeMockClient() as any;
      client.user = undefined;

      // Should not throw
      await gateway.handleConnection(client);
    });
  });

  describe('handleSendMessage', () => {
    it('should return error if userId is not set', async () => {
      const client = makeMockClient() as any;
      client.user = undefined;

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: { text: 'hi' },
      });

      expect(result).toEqual({ error: 'Unauthorized' });
    });

    it('should return error if user is not a member', async () => {
      const client = makeMockClient(1) as any;
      roomService.isUserInRoom.mockResolvedValue(false);

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: { text: 'hi' },
      });

      expect(result).toEqual({ error: 'You are not a member of this room' });
    });

    it('should send pair-wise message via sendToRoom', async () => {
      const client = makeMockClient(1) as any;

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: { text: 'hi' },
        category: 'user',
        type: 'text',
      });

      expect(result.success).toBe(true);
      expect(messageService.sendToRoom).toHaveBeenCalledWith(
        1,
        1,
        1, // deviceId from socket auth
        { text: 'hi' },
        'user',
        'text',
        client.id,
        false,
        undefined, // clientMessageId — absent (legacy client)
      );
    });

    it('should send sender-key message via deliverEnvelopeToRoom', async () => {
      const client = makeMockClient(1) as any;
      const room = makeRoom({ id: 1, useSenderKeys: true });
      roomService.getRoomById.mockResolvedValue(room);

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: {
          payload: {
            ciphertext: 'encrypted-data',
            distributionId: 'dist-1',
          },
        },
        category: 'senderkey_message',
        type: 'text',
      });

      expect(result.success).toBe(true);
      expect(messageService.deliverEnvelopeToRoom).toHaveBeenCalled();
    });

    it('should reject oversized non-volatile payload', async () => {
      const client = makeMockClient(1) as any;
      const bigMessage = { data: 'x'.repeat(65 * 1024) };

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: bigMessage,
      });

      expect(result.error).toContain('Message too large');
    });

    it('should allow large payload if volatile', async () => {
      const client = makeMockClient(1) as any;
      const bigMessage = { data: 'x'.repeat(65 * 1024) };

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        message: bigMessage,
        volatile: true,
      });

      expect(result.success).toBe(true);
    });

    it('should size fan-out recipients per-ciphertext, not the summed array', async () => {
      const client = makeMockClient(1) as any;
      // 5 devices × 20KB each = 100KB summed (> 64KB cap) but each is well
      // under the per-message limit — must be accepted.
      const recipients = Array.from({ length: 5 }, (_, i) => ({
        userId: 2,
        deviceId: i + 1,
        ciphertext: 'x'.repeat(20 * 1024),
      }));

      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        recipients,
      });

      expect(result.success).toBe(true);
      expect(messageService.fanOutToRecipients).toHaveBeenCalled();
    });

    it('should reject a fan-out recipient whose ciphertext exceeds the cap', async () => {
      const client = makeMockClient(1) as any;
      const result = await gateway.handleSendMessage(client, {
        roomId: 1,
        recipients: [
          { userId: 2, deviceId: 1, ciphertext: 'x'.repeat(65 * 1024) },
        ],
      });

      expect(result.error).toContain('Message too large');
      expect(messageService.fanOutToRecipients).not.toHaveBeenCalled();
    });
  });

  describe('handleSendPacket', () => {
    it('should return error if unauthorized', async () => {
      const client = makeMockClient() as any;
      client.user = undefined;

      const result = await gateway.handleSendPacket(client, {
        roomId: 1,
        packet: { type: 'test' },
      });

      expect(result).toEqual({ error: 'Unauthorized' });
    });

    it('should return error if not a member', async () => {
      const client = makeMockClient(1) as any;
      roomService.isUserInRoom.mockResolvedValue(false);

      const result = await gateway.handleSendPacket(client, {
        roomId: 1,
        packet: { type: 'test' },
      });

      expect(result).toEqual({ error: 'You are not a member of this room' });
    });

    it('should send control packet via messageService', async () => {
      const client = makeMockClient(1) as any;

      const result = await gateway.handleSendPacket(client, {
        roomId: 1,
        packet: { type: 'SESSION_ESTABLISHED' },
        recipientIds: [2],
      });

      expect(result.success).toBe(true);
      expect(messageService.sendControlPacket).toHaveBeenCalledWith(
        1,
        1,
        1, // deviceId from socket auth
        { type: 'SESSION_ESTABLISHED' },
        [2],
        client.id,
        undefined,
      );
    });
  });

  describe('handleJoinRoom', () => {
    it('should join Socket.IO room and broadcast', async () => {
      const client = makeMockClient(1) as any;

      const result = await gateway.handleJoinRoom(client, { roomId: 1 });

      expect(result.success).toBe(true);
      expect(client.join).toHaveBeenCalledWith('room:1');
      expect(messageService.broadcastToRoomMembers).toHaveBeenCalledWith(
        1,
        ChatEvents.UserJoined,
        expect.objectContaining({ userId: 1, roomId: 1 }),
      );
    });

    it('should return error if not a member', async () => {
      const client = makeMockClient(1) as any;
      roomService.isUserInRoom.mockResolvedValue(false);

      const result = await gateway.handleJoinRoom(client, { roomId: 1 });

      expect(result).toEqual({ error: 'You are not a member of this room' });
    });
  });

  describe('handleLeaveRoom', () => {
    it('should leave Socket.IO room and broadcast', async () => {
      const client = makeMockClient(1) as any;

      const result = await gateway.handleLeaveRoom(client, { roomId: 1 });

      expect(result.success).toBe(true);
      expect(client.leave).toHaveBeenCalledWith('room:1');
      expect(messageService.broadcastToRoomMembers).toHaveBeenCalledWith(
        1,
        ChatEvents.UserLeft,
        expect.objectContaining({ userId: 1, roomId: 1 }),
      );
    });

    it('should return error if not a member', async () => {
      const client = makeMockClient(1) as any;
      roomService.isUserInRoom.mockResolvedValue(false);

      const result = await gateway.handleLeaveRoom(client, { roomId: 1 });

      expect(result).toEqual({ error: 'You are not a member of this room' });
    });
  });

  // Liveness lock — level-triggered behaviour (ADR-0011, backend-0022).
  describe('primary liveness anchor (part A)', () => {
    it('bumps the primary anchor on socket activity (a connected primary stays alive)', async () => {
      // deviceId 1 = primary. This is the regression for defect #2: a primary
      // holding a persistent socket must keep itself "alive" via in-session
      // activity, not only at connect.
      const primary = makeMockClient(7, 'sock-primary', 1) as any;

      await gateway.handleSendMessage(primary, {
        roomId: 1,
        message: { payload: { ciphertext: 'x' } },
      });

      expect(authService.refreshPrimaryLiveness).toHaveBeenCalledWith(7);
    });

    it('does NOT bump the anchor for a linked device (a rogue linked device cannot keep itself alive)', async () => {
      const linked = makeMockClient(7, 'sock-linked', 2) as any;

      await gateway.handleSendMessage(linked, {
        roomId: 1,
        message: { payload: { ciphertext: 'x' } },
      });

      expect(authService.refreshPrimaryLiveness).not.toHaveBeenCalled();
    });

    it('throttles high-frequency activity to a single anchor write per window', async () => {
      const primary = makeMockClient(7, 'sock-primary', 1) as any;

      for (let i = 0; i < 50; i++) {
        await gateway.handleSendMessage(primary, { roomId: 1, message: {} });
      }

      // In-memory throttle (1h) collapses the burst to one write.
      expect(authService.refreshPrimaryLiveness).toHaveBeenCalledTimes(1);
    });

    it('clears the throttle entry on disconnect', () => {
      const primary = makeMockClient(7, 'sock-primary', 1) as any;
      gateway.handleDisconnect(primary);
      // No throw; entry removed so a fresh connection bumps immediately.
      expect(authService.refreshPrimaryLiveness).not.toHaveBeenCalled();
    });
  });

  describe('liveness enforcement sweep (part B)', () => {
    // Build a fake socket with a `.user` and a spyable disconnect().
    const fakeSocket = (userId: number, deviceId: number, id: string) => ({
      id,
      user: { userId, deviceId },
      disconnect: jest.fn(),
    });

    const serverWith = (sockets: any[]) =>
      ({
        adapter: jest.fn(),
        local: { fetchSockets: jest.fn().mockResolvedValue(sockets) },
      }) as any;

    const sweep = () => (gateway as any).sweepLivenessLockedDevices();

    it('force-disconnects a linked device when the primary has gone stale', async () => {
      const linked = fakeSocket(7, 2, 'sock-linked');
      gateway.server = serverWith([linked]);
      authService.assertPrimaryActive.mockRejectedValue(
        new UnauthorizedException('Primary device inactive', 'PRIMARY_INACTIVE'),
      );

      await sweep();

      expect(authService.assertPrimaryActive).toHaveBeenCalledWith(7);
      expect(linked.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects a passive linked device (no outbound traffic required)', async () => {
      // The stolen-passive case: the device only receives. The sweep does not
      // depend on it emitting anything.
      const passive = fakeSocket(9, 3, 'sock-passive');
      gateway.server = serverWith([passive]);
      authService.assertPrimaryActive.mockRejectedValue(
        new UnauthorizedException('Primary device inactive', 'PRIMARY_INACTIVE'),
      );

      await sweep();

      expect(passive.disconnect).toHaveBeenCalledWith(true);
    });

    it('leaves a linked device connected while the primary is active (no false positive)', async () => {
      const linked = fakeSocket(7, 2, 'sock-linked');
      gateway.server = serverWith([linked]);
      authService.assertPrimaryActive.mockResolvedValue(undefined);

      await sweep();

      expect(linked.disconnect).not.toHaveBeenCalled();
    });

    it('never disconnects the primary itself (the anchor is exempt)', async () => {
      const primary = fakeSocket(7, 1, 'sock-primary');
      gateway.server = serverWith([primary]);
      // Even if the check would throw, the primary must not be enrolled.
      authService.assertPrimaryActive.mockRejectedValue(
        new UnauthorizedException('Primary device inactive', 'PRIMARY_INACTIVE'),
      );

      await sweep();

      expect(authService.assertPrimaryActive).not.toHaveBeenCalled();
      expect(primary.disconnect).not.toHaveBeenCalled();
    });

    it('checks each user once even with several linked sockets', async () => {
      const a = fakeSocket(7, 2, 'a');
      const b = fakeSocket(7, 3, 'b');
      gateway.server = serverWith([a, b]);
      authService.assertPrimaryActive.mockRejectedValue(
        new UnauthorizedException('Primary device inactive', 'PRIMARY_INACTIVE'),
      );

      await sweep();

      expect(authService.assertPrimaryActive).toHaveBeenCalledTimes(1);
      expect(a.disconnect).toHaveBeenCalledWith(true);
      expect(b.disconnect).toHaveBeenCalledWith(true);
    });

    it('does NOT disconnect on a transient (non-liveness) error', async () => {
      // A momentary DB error inside assertPrimaryActive must not be mistaken
      // for PRIMARY_INACTIVE — otherwise a blip force-disconnects every linked
      // device. Only an UnauthorizedException is the real liveness signal.
      const linked = fakeSocket(7, 2, 'sock-linked');
      gateway.server = serverWith([linked]);
      authService.assertPrimaryActive.mockRejectedValue(
        new Error('ECONNREFUSED: database is down'),
      );

      await sweep();

      expect(linked.disconnect).not.toHaveBeenCalled();
    });
  });
});
