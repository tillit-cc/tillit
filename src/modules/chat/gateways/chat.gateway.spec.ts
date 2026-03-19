import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { MessageService } from '../services/message.service';
import { RoomService } from '../services/room.service';
import { SenderKeysService } from '../../sender-keys/services/sender-keys.service';
import { RedisConfigService } from '../../../config/database/redis/config.service';
import { ChatEvents } from '../interfaces/chat-events';
import { makeRoom, makeMockClient } from '../../../test/helpers';

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
  };
  let roomService: {
    getUserRooms: jest.Mock;
    isUserInRoom: jest.Mock;
    getRoomById: jest.Mock;
  };
  let senderKeysService: {
    setServer: jest.Mock;
    getPendingSenderKeys: jest.Mock;
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
        ackedUserIds: [],
      }),
    };

    roomService = {
      getUserRooms: jest.fn().mockResolvedValue([]),
      isUserInRoom: jest.fn().mockResolvedValue(true),
      getRoomById: jest.fn(),
    };

    senderKeysService = {
      setServer: jest.fn(),
      getPendingSenderKeys: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: MessageService, useValue: messageService },
        { provide: RoomService, useValue: roomService },
        { provide: SenderKeysService, useValue: senderKeysService },
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
        { text: 'hi' },
        'user',
        'text',
        client.id,
        false,
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
});
