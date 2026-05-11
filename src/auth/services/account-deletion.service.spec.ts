import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs';

import { AccountDeletionService } from './account-deletion.service';
import { User } from '../../entities/user.entity';
import { Room } from '../../entities/room.entity';
import { RoomUser } from '../../entities/room-user.entity';
import { SignalKey } from '../../entities/signal-key.entity';
import { PushToken } from '../../entities/push-token.entity';
import { PendingMessage } from '../../entities/pending-message.entity';
import { MediaBlob } from '../../entities/media-blob.entity';
import { Report } from '../../entities/report.entity';
import { SenderKeyDistribution } from '../../entities/sender-key-distribution.entity';
import { MessageService } from '../../modules/chat/services/message.service';
import { BanService } from '../../modules/ban/ban.service';
import { MediaConfigService } from '../../config/media/config.service';
import { ChatEvents } from '../../modules/chat/interfaces/chat-events';
import {
  createMockRepository,
  createMockDataSource,
  makeUser,
  makeRoom,
  makeRoomUser,
  makePendingMessage,
  makeMediaBlob,
} from '../../test/helpers';

describe('AccountDeletionService', () => {
  let service: AccountDeletionService;
  let userRepo: ReturnType<typeof createMockRepository>;
  let roomRepo: ReturnType<typeof createMockRepository>;
  let roomUserRepo: ReturnType<typeof createMockRepository>;
  let signalKeyRepo: ReturnType<typeof createMockRepository>;
  let pushTokenRepo: ReturnType<typeof createMockRepository>;
  let pendingRepo: ReturnType<typeof createMockRepository>;
  let mediaRepo: ReturnType<typeof createMockRepository>;
  let reportRepo: ReturnType<typeof createMockRepository>;
  let skdRepo: ReturnType<typeof createMockRepository>;
  let dataSource: ReturnType<typeof createMockDataSource>;
  let messageService: {
    broadcastToRoomMembers: jest.Mock;
  };
  let banService: { unbanUser: jest.Mock };
  let mediaConfig: { storageDir: string };
  let unlinkSpy: jest.SpyInstance;

  beforeEach(async () => {
    userRepo = createMockRepository();
    roomRepo = createMockRepository();
    roomUserRepo = createMockRepository();
    signalKeyRepo = createMockRepository();
    pushTokenRepo = createMockRepository();
    pendingRepo = createMockRepository();
    mediaRepo = createMockRepository();
    reportRepo = createMockRepository();
    skdRepo = createMockRepository();
    dataSource = createMockDataSource();
    (dataSource as any)._mockManager.update = jest
      .fn()
      .mockResolvedValue({ affected: 0 });
    messageService = { broadcastToRoomMembers: jest.fn() };
    banService = { unbanUser: jest.fn().mockResolvedValue(true) };
    mediaConfig = { storageDir: '/tmp/test-media' };

    // Sender-key count uses createQueryBuilder().where().orWhere().getCount()
    skdRepo.createQueryBuilder = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    });

    // Member-count query uses createQueryBuilder().select().addSelect().where().groupBy().getRawMany()
    roomUserRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    });

    unlinkSpy = jest
      .spyOn(fs.promises, 'unlink')
      .mockResolvedValue(undefined as unknown as void);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Room), useValue: roomRepo },
        { provide: getRepositoryToken(RoomUser), useValue: roomUserRepo },
        { provide: getRepositoryToken(SignalKey), useValue: signalKeyRepo },
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(PendingMessage), useValue: pendingRepo },
        { provide: getRepositoryToken(MediaBlob), useValue: mediaRepo },
        { provide: getRepositoryToken(Report), useValue: reportRepo },
        {
          provide: getRepositoryToken(SenderKeyDistribution),
          useValue: skdRepo,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: MessageService, useValue: messageService },
        { provide: BanService, useValue: banService },
        { provide: MediaConfigService, useValue: mediaConfig },
      ],
    }).compile();

    service = module.get(AccountDeletionService);
  });

  afterEach(() => {
    unlinkSpy.mockRestore();
  });

  it('returns zero-stats when the user is already gone (idempotent)', async () => {
    userRepo.findOne.mockResolvedValue(null);

    const stats = await service.deleteAccount(42);

    expect(stats).toEqual({
      userId: null,
      rooms: 0,
      messages: 0,
      preKeys: 0,
      senderKeyDistributions: 0,
      pushTokens: 0,
      reports: 0,
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(banService.unbanUser).not.toHaveBeenCalled();
  });

  it('deletes user with no rooms — counters reflect zero', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ id: 7 }));
    roomUserRepo.find.mockResolvedValue([]);
    roomRepo.find.mockResolvedValue([]);

    signalKeyRepo.count.mockResolvedValue(5);
    pushTokenRepo.count.mockResolvedValue(1);
    reportRepo.count.mockResolvedValue(0);
    pendingRepo.count.mockResolvedValue(0);
    pendingRepo.find.mockResolvedValue([]);
    mediaRepo.find.mockResolvedValue([]);

    const stats = await service.deleteAccount(7);

    expect(stats.userId).toBe(7);
    expect(stats.rooms).toBe(0);
    expect(stats.preKeys).toBe(5);
    expect(stats.pushTokens).toBe(1);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);

    const manager = (dataSource as any)._mockManager;
    expect(manager.delete).toHaveBeenCalledWith(User, 7);
    expect(banService.unbanUser).toHaveBeenCalledWith(7);
  });

  it('broadcasts userLeftRoom in shared rooms and roomDeleted in owned rooms', async () => {
    const userId = 11;
    userRepo.findOne.mockResolvedValue(makeUser({ id: userId }));

    // User is a member of three rooms:
    //  - 100: creator => roomDeleted
    //  - 200: regular member, two members => userLeftRoom
    //  - 300: sole member => roomDeleted (no broadcast listeners but event still fires)
    roomUserRepo.find.mockResolvedValue([
      makeRoomUser({ roomId: 100, userId }),
      makeRoomUser({ roomId: 200, userId }),
      makeRoomUser({ roomId: 300, userId }),
    ]);
    roomRepo.find.mockResolvedValue([
      makeRoom({ id: 100, idUser: userId }),
      makeRoom({ id: 200, idUser: 999 }),
      makeRoom({ id: 300, idUser: 999 }),
    ]);

    roomUserRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { roomId: 100, count: '3' },
        { roomId: 200, count: '2' },
        { roomId: 300, count: '1' },
      ]),
    });

    signalKeyRepo.count.mockResolvedValue(0);
    pushTokenRepo.count.mockResolvedValue(0);
    reportRepo.count.mockResolvedValue(0);
    pendingRepo.count.mockResolvedValue(0);
    pendingRepo.find.mockResolvedValue([]);
    mediaRepo.find.mockResolvedValue([]);

    await service.deleteAccount(userId);

    const broadcastCalls = messageService.broadcastToRoomMembers.mock.calls;
    const events = broadcastCalls.map(([roomId, event]) => ({ roomId, event }));

    expect(events).toEqual(
      expect.arrayContaining([
        { roomId: 100, event: ChatEvents.RoomDeleted },
        { roomId: 200, event: ChatEvents.UserLeftRoom },
        { roomId: 300, event: ChatEvents.RoomDeleted },
      ]),
    );

    // Explicit room delete only for orphan (sole-member, not owner)
    const manager = (dataSource as any)._mockManager;
    expect(manager.delete).toHaveBeenCalledWith(Room, [300]);
  });

  it('anonymises reports filed against the deleted user', async () => {
    userRepo.findOne.mockResolvedValue(makeUser({ id: 5 }));
    roomUserRepo.find.mockResolvedValue([]);
    roomRepo.find.mockResolvedValue([]);
    pendingRepo.count.mockResolvedValue(0);
    pendingRepo.find.mockResolvedValue([]);
    mediaRepo.find.mockResolvedValue([]);
    signalKeyRepo.count.mockResolvedValue(0);
    pushTokenRepo.count.mockResolvedValue(0);
    reportRepo.count.mockResolvedValue(3);

    await service.deleteAccount(5);

    const manager = (dataSource as any)._mockManager;
    expect(manager.update).toHaveBeenCalledWith(
      Report,
      { reportedUserId: 5 },
      { reportedUserId: null },
    );
  });

  it('removes outbound pending messages where envelope.senderId matches user', async () => {
    const userId = 22;
    userRepo.findOne.mockResolvedValue(makeUser({ id: userId }));
    roomUserRepo.find.mockResolvedValue([makeRoomUser({ roomId: 1, userId })]);
    roomRepo.find.mockResolvedValue([makeRoom({ id: 1, idUser: userId })]);

    roomUserRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ roomId: 1, count: '2' }]),
    });

    signalKeyRepo.count.mockResolvedValue(0);
    pushTokenRepo.count.mockResolvedValue(0);
    reportRepo.count.mockResolvedValue(0);
    pendingRepo.count.mockResolvedValue(0);

    pendingRepo.find.mockResolvedValue([
      makePendingMessage({
        id: 'a',
        envelope: JSON.stringify({ senderId: userId, roomId: 1 }),
      }),
      makePendingMessage({
        id: 'b',
        envelope: JSON.stringify({ senderId: 999, roomId: 1 }),
      }),
      makePendingMessage({
        id: 'c',
        envelope: 'malformed-json',
      }),
    ]);

    mediaRepo.find.mockResolvedValue([]);

    await service.deleteAccount(userId);

    const manager = (dataSource as any)._mockManager;
    // Only message "a" should be deleted (sender matches; "c" is skipped)
    expect(manager.delete).toHaveBeenCalledWith(PendingMessage, ['a']);
  });

  it('cleans up media files on disk before deleting the user record', async () => {
    const userId = 33;
    userRepo.findOne.mockResolvedValue(makeUser({ id: userId }));
    roomUserRepo.find.mockResolvedValue([]);
    roomRepo.find.mockResolvedValue([]);
    signalKeyRepo.count.mockResolvedValue(0);
    pushTokenRepo.count.mockResolvedValue(0);
    reportRepo.count.mockResolvedValue(0);
    pendingRepo.count.mockResolvedValue(0);
    pendingRepo.find.mockResolvedValue([]);

    mediaRepo.find
      .mockResolvedValueOnce([
        makeMediaBlob({ id: 'm1', filePath: 'm1.enc', uploaderId: userId }),
        makeMediaBlob({ id: 'm2', filePath: 'm2.enc', uploaderId: userId }),
      ])
      .mockResolvedValueOnce([]);

    await service.deleteAccount(userId);

    expect(unlinkSpy).toHaveBeenCalledTimes(2);
  });
});
