import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import { RoomService } from './room.service';
import { Room, RoomStatus } from '../../../entities/room.entity';
import { RoomUser } from '../../../entities/room-user.entity';
import { User } from '../../../entities/user.entity';
import { MediaBlob } from '../../../entities/media-blob.entity';
import { PendingMessage } from '../../../entities/pending-message.entity';
import { MediaConfigService } from '../../../config/media/config.service';
import {
  createMockRepository,
  createMockDataSource,
  makeUser,
  makeRoom,
  makeRoomUser,
  makeMediaBlob,
} from '../../../test/helpers';

describe('RoomService', () => {
  let service: RoomService;
  let roomRepo: ReturnType<typeof createMockRepository>;
  let roomUserRepo: ReturnType<typeof createMockRepository>;
  let userRepo: ReturnType<typeof createMockRepository>;
  let mediaBlobRepo: ReturnType<typeof createMockRepository>;
  let pendingMessageRepo: ReturnType<typeof createMockRepository>;
  let dataSource: ReturnType<typeof createMockDataSource>;
  let mediaConfig: { storageDir: string };

  beforeEach(async () => {
    roomRepo = createMockRepository();
    roomUserRepo = createMockRepository();
    userRepo = createMockRepository();
    mediaBlobRepo = createMockRepository();
    pendingMessageRepo = createMockRepository();
    dataSource = createMockDataSource();
    mediaConfig = { storageDir: '/tmp/media' };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomService,
        { provide: getRepositoryToken(Room), useValue: roomRepo },
        { provide: getRepositoryToken(RoomUser), useValue: roomUserRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(MediaBlob), useValue: mediaBlobRepo },
        {
          provide: getRepositoryToken(PendingMessage),
          useValue: pendingMessageRepo,
        },
        { provide: MediaConfigService, useValue: mediaConfig },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<RoomService>(RoomService);
  });

  describe('createRoom', () => {
    it('should create a room with invite code and add creator as member', async () => {
      const creator = makeUser({ id: 1 });
      userRepo.findOne.mockResolvedValue(creator);
      roomRepo.findOne.mockResolvedValue(null); // invite code is unique
      roomRepo.save.mockImplementation((room: any) =>
        Promise.resolve({ ...room, id: 10 }),
      );
      roomUserRepo.count.mockResolvedValue(0);

      const result = await service.createRoom(1, 'MyRoom', 'Alice');

      expect(result.inviteCode).toBeDefined();
      expect(result.name).toBe('MyRoom');
      expect(result.status).toBe(RoomStatus.CREATED);
      expect(roomUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, username: 'Alice' }),
      );
      expect(roomUserRepo.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if creator does not exist', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.createRoom(999)).rejects.toThrow(NotFoundException);
    });

    it('should generate default username when not provided', async () => {
      const creator = makeUser({ id: 1 });
      userRepo.findOne.mockResolvedValue(creator);
      roomRepo.findOne.mockResolvedValue(null);
      roomRepo.save.mockImplementation((room: any) =>
        Promise.resolve({ ...room, id: 10 }),
      );
      roomUserRepo.count.mockResolvedValue(0);

      await service.createRoom(1, 'Room');

      expect(roomUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'User 1' }),
      );
    });

    it('should set administered flag', async () => {
      const creator = makeUser({ id: 1 });
      userRepo.findOne.mockResolvedValue(creator);
      roomRepo.findOne.mockResolvedValue(null);
      roomRepo.save.mockImplementation((room: any) =>
        Promise.resolve({ ...room, id: 10 }),
      );
      roomUserRepo.count.mockResolvedValue(0);

      await service.createRoom(1, 'Room', 'Alice', true);

      expect(roomRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ administered: true }),
      );
    });
  });

  describe('joinRoomByCode', () => {
    it('should add user and set status to ACTIVE', async () => {
      const room = makeRoom({ id: 1, status: RoomStatus.CREATED });
      const user = makeUser({ id: 2 });

      roomRepo.findOne.mockResolvedValue(room);
      userRepo.findOne.mockResolvedValue(user);
      roomUserRepo.findOne.mockResolvedValue(null); // not already a member
      roomUserRepo.count.mockResolvedValue(1);

      const result = await service.joinRoomByCode('abc12345', 2, 'Bob');

      expect(result.alreadyJoined).toBe(false);
      expect(result.room.status).toBe(RoomStatus.ACTIVE);
      expect(roomUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 2, username: 'Bob' }),
      );
    });

    it('should return alreadyJoined=true if user is already a member', async () => {
      const room = makeRoom({ id: 1, status: RoomStatus.ACTIVE });
      const user = makeUser({ id: 2 });
      const existingMembership = makeRoomUser({
        roomId: 1,
        userId: 2,
        username: 'Bob',
      });

      roomRepo.findOne.mockResolvedValue(room);
      userRepo.findOne.mockResolvedValue(user);
      roomUserRepo.findOne.mockResolvedValue(existingMembership);

      const result = await service.joinRoomByCode('abc12345', 2);

      expect(result.alreadyJoined).toBe(true);
    });

    it('should update username on re-join if different', async () => {
      const room = makeRoom({ id: 1, status: RoomStatus.ACTIVE });
      const user = makeUser({ id: 2 });
      const existingMembership = makeRoomUser({
        roomId: 1,
        userId: 2,
        username: 'OldName',
      });

      roomRepo.findOne.mockResolvedValue(room);
      userRepo.findOne.mockResolvedValue(user);
      roomUserRepo.findOne.mockResolvedValue(existingMembership);

      await service.joinRoomByCode('abc12345', 2, 'NewName');

      expect(roomUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'NewName' }),
      );
    });

    it('should throw NotFoundException for invalid invite code', async () => {
      roomRepo.findOne.mockResolvedValue(null);

      await expect(service.joinRoomByCode('invalid', 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if user does not exist', async () => {
      const room = makeRoom({ id: 1 });
      roomRepo.findOne.mockResolvedValue(room);
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.joinRoomByCode('abc12345', 999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteRoom', () => {
    it('should delete media files and room in a transaction', async () => {
      const blob = makeMediaBlob({ filePath: 'room-1/file.enc' });
      mediaBlobRepo.find.mockResolvedValue([blob]);
      jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);

      await service.deleteRoom(1);

      expect(fs.promises.unlink).toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('should handle missing media files gracefully (best-effort)', async () => {
      const blob = makeMediaBlob({ filePath: 'room-1/missing.enc' });
      mediaBlobRepo.find.mockResolvedValue([blob]);
      jest.spyOn(fs.promises, 'unlink').mockRejectedValue(new Error('ENOENT'));

      // Should not throw
      await expect(service.deleteRoom(1)).resolves.toBeUndefined();
    });

    it('should skip path traversal attempts', async () => {
      const blob = makeMediaBlob({ filePath: '../../etc/passwd' });
      mediaBlobRepo.find.mockResolvedValue([blob]);
      const unlinkSpy = jest
        .spyOn(fs.promises, 'unlink')
        .mockResolvedValue(undefined);

      await service.deleteRoom(1);

      expect(unlinkSpy).not.toHaveBeenCalled();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });
  });

  describe('leaveRoom', () => {
    it('should remove membership and pending messages', async () => {
      await service.leaveRoom(1, 2);

      expect(roomUserRepo.delete).toHaveBeenCalledWith({
        roomId: 1,
        userId: 2,
      });
      expect(pendingMessageRepo.delete).toHaveBeenCalledWith({
        roomId: 1,
        userId: 2,
      });
    });
  });

  describe('getRoomMembers', () => {
    it('should return members with username', async () => {
      const room = makeRoom({ id: 1 });
      const user = makeUser({ id: 1 });
      const membership = makeRoomUser({
        roomId: 1,
        userId: 1,
        username: 'Alice',
      });
      membership.user = user;

      roomRepo.findOne.mockResolvedValue(room);
      roomUserRepo.find.mockResolvedValue([membership]);

      const result = await service.getRoomMembers(1);

      expect(result).toHaveLength(1);
      expect(result[0].username).toBe('Alice');
      expect(result[0].id).toBe(1);
    });

    it('should throw NotFoundException if room does not exist', async () => {
      roomRepo.findOne.mockResolvedValue(null);

      await expect(service.getRoomMembers(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateRoomName', () => {
    it('should update the room name', async () => {
      const room = makeRoom({ id: 1, name: 'OldName' });
      roomRepo.findOne.mockResolvedValue(room);
      roomUserRepo.findOne.mockResolvedValue(makeRoomUser());

      const result = await service.updateRoomName(1, 1, 'NewName');

      expect(result.name).toBe('NewName');
      expect(roomRepo.save).toHaveBeenCalled();
    });

    it('should throw ForbiddenException if user is not a member', async () => {
      const room = makeRoom({ id: 1 });
      roomRepo.findOne.mockResolvedValue(room);
      roomUserRepo.findOne.mockResolvedValue(null);

      await expect(service.updateRoomName(1, 999, 'NewName')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('usersShareRoom', () => {
    it('should return true when users share a room', async () => {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(makeRoomUser()),
      };
      roomUserRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.usersShareRoom(1, 2);

      expect(result).toBe(true);
      expect(qb.innerJoin).toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('ru1.userId = :userId1', {
        userId1: 1,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('ru2.userId = :userId2', {
        userId2: 2,
      });
    });

    it('should return false when users do not share a room', async () => {
      const qb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      roomUserRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.usersShareRoom(1, 2);

      expect(result).toBe(false);
    });
  });

  describe('updateMemberUsername', () => {
    it('should update username', async () => {
      const membership = makeRoomUser({ username: 'OldName' });
      roomUserRepo.findOne.mockResolvedValue(membership);

      await service.updateMemberUsername(1, 1, 'NewName');

      expect(roomUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'NewName' }),
      );
    });

    it('should throw NotFoundException if membership does not exist', async () => {
      roomUserRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateMemberUsername(1, 999, 'Name'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
