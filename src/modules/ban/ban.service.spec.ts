import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BanService } from './ban.service';
import { BannedUser } from '../../entities/banned-user.entity';
import { createMockRepository } from '../../test/helpers';

describe('BanService', () => {
  let service: BanService;
  let bannedUserRepo: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    bannedUserRepo = createMockRepository();
    // Default: no banned users
    bannedUserRepo.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BanService,
        {
          provide: getRepositoryToken(BannedUser),
          useValue: bannedUserRepo,
        },
      ],
    }).compile();

    service = module.get<BanService>(BanService);
  });

  describe('isUserBanned', () => {
    it('should return false for non-banned user', async () => {
      const result = await service.isUserBanned(1);
      expect(result).toBe(false);
    });

    it('should return true for banned user', async () => {
      bannedUserRepo.find.mockResolvedValue([
        { id: 1, userId: 42, reason: 'spam', bannedAt: Date.now() },
      ]);

      // Need a fresh instance to reload cache
      const module = await Test.createTestingModule({
        providers: [
          BanService,
          {
            provide: getRepositoryToken(BannedUser),
            useValue: bannedUserRepo,
          },
        ],
      }).compile();
      const svc = module.get<BanService>(BanService);

      expect(await svc.isUserBanned(42)).toBe(true);
      expect(await svc.isUserBanned(99)).toBe(false);
    });
  });

  describe('banUser', () => {
    it('should ban a user and add to cache', async () => {
      bannedUserRepo.findOne.mockResolvedValue(null);

      const result = await service.banUser(1, 'spam');

      expect(bannedUserRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          reason: 'spam',
        }),
      );
      expect(bannedUserRepo.save).toHaveBeenCalled();
      expect(await service.isUserBanned(1)).toBe(true);
    });

    it('should return existing ban if user is already banned', async () => {
      const existing = {
        id: 1,
        userId: 1,
        reason: 'spam',
        bannedAt: Date.now(),
      };
      bannedUserRepo.findOne.mockResolvedValue(existing);

      const result = await service.banUser(1, 'harassment');

      expect(bannedUserRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual(existing);
    });
  });

  describe('unbanUser', () => {
    it('should unban a user and remove from cache', async () => {
      // First ban
      bannedUserRepo.findOne.mockResolvedValue(null);
      await service.banUser(1);
      expect(await service.isUserBanned(1)).toBe(true);

      // Then unban
      bannedUserRepo.delete.mockResolvedValue({ affected: 1 });
      const result = await service.unbanUser(1);

      expect(result).toBe(true);
      expect(await service.isUserBanned(1)).toBe(false);
    });

    it('should return false if user was not banned', async () => {
      bannedUserRepo.delete.mockResolvedValue({ affected: 0 });
      const result = await service.unbanUser(999);
      expect(result).toBe(false);
    });
  });

  describe('listBannedUsers', () => {
    it('should return all banned users', async () => {
      const banned = [
        { id: 1, userId: 1, reason: 'spam', bannedAt: Date.now() },
        { id: 2, userId: 2, reason: null, bannedAt: Date.now() },
      ];
      bannedUserRepo.find.mockResolvedValue(banned);

      // Need fresh call since find was already called for cache
      const result = await service.listBannedUsers();
      expect(result).toEqual(banned);
    });
  });
});
