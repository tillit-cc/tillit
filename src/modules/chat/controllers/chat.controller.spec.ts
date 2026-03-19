import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { RoomService } from '../services/room.service';
import { MessageService } from '../services/message.service';
import { RoomStatus } from '../../../entities/room.entity';
import { ChatEvents } from '../interfaces/chat-events';
import { makeRoom } from '../../../test/helpers';

describe('ChatController', () => {
  let controller: ChatController;
  let roomService: {
    createRoom: jest.Mock;
    joinRoomByCode: jest.Mock;
    deleteRoom: jest.Mock;
    leaveRoom: jest.Mock;
    getUserRooms: jest.Mock;
    getRoomById: jest.Mock;
    isUserInRoom: jest.Mock;
    getRoomMembers: jest.Mock;
  };
  let messageService: {
    broadcastToRoomMembers: jest.Mock;
    sendToRoom: jest.Mock;
  };

  const mockReq = (userId: number) => ({ user: { userId } }) as any;

  beforeEach(async () => {
    roomService = {
      createRoom: jest.fn(),
      joinRoomByCode: jest.fn(),
      deleteRoom: jest.fn(),
      leaveRoom: jest.fn(),
      getUserRooms: jest.fn(),
      getRoomById: jest.fn(),
      isUserInRoom: jest.fn(),
      getRoomMembers: jest.fn(),
    };

    messageService = {
      broadcastToRoomMembers: jest.fn(),
      sendToRoom: jest.fn().mockResolvedValue({
        id: 'msg-1',
        delivered: true,
        timestamp: new Date().toISOString(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: RoomService, useValue: roomService },
        { provide: MessageService, useValue: messageService },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
  });

  describe('createRoom', () => {
    it('should create room and return invite code with metadata', async () => {
      const room = makeRoom({
        id: 1,
        inviteCode: 'abc123',
        name: 'MyRoom',
        status: RoomStatus.CREATED,
        idUser: 1,
        administered: false,
      });
      roomService.createRoom.mockResolvedValue(room);

      const result = await controller.createRoom(mockReq(1), {
        name: 'MyRoom',
        username: 'Alice',
      });

      expect(result.inviteCode).toBe('abc123');
      expect(result.name).toBe('MyRoom');
      expect(result.roomId).toBe(1);
      expect(roomService.createRoom).toHaveBeenCalledWith(
        1,
        'MyRoom',
        'Alice',
        undefined,
      );
    });

    it('should pass administered flag', async () => {
      const room = makeRoom({ administered: true });
      roomService.createRoom.mockResolvedValue(room);

      const result = await controller.createRoom(mockReq(1), {
        name: 'Admin Room',
        administered: true,
      });

      expect(result.administered).toBe(true);
      expect(roomService.createRoom).toHaveBeenCalledWith(
        1,
        'Admin Room',
        undefined,
        true,
      );
    });
  });

  describe('joinRoom', () => {
    it('should join by invite code', async () => {
      const room = makeRoom({
        id: 1,
        inviteCode: 'abc123',
        status: RoomStatus.ACTIVE,
      });
      roomService.joinRoomByCode.mockResolvedValue({
        room,
        alreadyJoined: false,
      });

      const result = await controller.joinRoom('abc123', mockReq(2), {
        username: 'Bob',
      });

      expect(result.inviteCode).toBe('abc123');
      expect(result.alreadyJoined).toBe(false);
    });
  });

  describe('deleteRoom', () => {
    it('should delete non-administered room and broadcast roomDeleted', async () => {
      const room = makeRoom({ id: 1, administered: false, idUser: 1 });
      roomService.getRoomById.mockResolvedValue(room);
      roomService.isUserInRoom.mockResolvedValue(true);

      const result = await controller.deleteRoom(1, mockReq(2));

      expect(result.action).toBe('deleted');
      expect(messageService.broadcastToRoomMembers).toHaveBeenCalledWith(
        1,
        ChatEvents.RoomDeleted,
        expect.objectContaining({ roomId: 1, deletedBy: 2 }),
      );
      expect(roomService.deleteRoom).toHaveBeenCalledWith(1);
    });

    it('should leave administered room for non-admin and broadcast userLeftRoom', async () => {
      const room = makeRoom({ id: 1, administered: true, idUser: 1 });
      roomService.getRoomById.mockResolvedValue(room);
      roomService.isUserInRoom.mockResolvedValue(true);

      const result = await controller.deleteRoom(1, mockReq(2)); // userId=2, not admin

      expect(result.action).toBe('left');
      expect(messageService.broadcastToRoomMembers).toHaveBeenCalledWith(
        1,
        ChatEvents.UserLeftRoom,
        expect.objectContaining({ roomId: 1, userId: 2 }),
      );
      expect(roomService.leaveRoom).toHaveBeenCalledWith(1, 2);
    });

    it('should delete administered room for admin', async () => {
      const room = makeRoom({ id: 1, administered: true, idUser: 1 });
      roomService.getRoomById.mockResolvedValue(room);
      roomService.isUserInRoom.mockResolvedValue(true);

      const result = await controller.deleteRoom(1, mockReq(1)); // admin

      expect(result.action).toBe('deleted');
      expect(roomService.deleteRoom).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException if room not found', async () => {
      roomService.getRoomById.mockRejectedValue(new NotFoundException());

      await expect(controller.deleteRoom(999, mockReq(1))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException if not a member', async () => {
      const room = makeRoom({ id: 1 });
      roomService.getRoomById.mockResolvedValue(room);
      roomService.isUserInRoom.mockResolvedValue(false);

      await expect(controller.deleteRoom(1, mockReq(99))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('getUserRooms', () => {
    it('should return all rooms for the user', async () => {
      const rooms = [
        makeRoom({ id: 1, name: 'Room 1' }),
        makeRoom({ id: 2, name: 'Room 2' }),
      ];
      roomService.getUserRooms.mockResolvedValue(rooms);

      const result = await controller.getUserRooms(mockReq(1));

      expect(result.rooms).toHaveLength(2);
      expect(result.rooms[0].name).toBe('Room 1');
      expect(result.rooms[1].name).toBe('Room 2');
    });

    it('should return empty array when user has no rooms', async () => {
      roomService.getUserRooms.mockResolvedValue([]);

      const result = await controller.getUserRooms(mockReq(1));

      expect(result.rooms).toHaveLength(0);
    });
  });
});
