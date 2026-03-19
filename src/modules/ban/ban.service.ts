import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BannedUser } from '../../entities/banned-user.entity';

@Injectable()
export class BanService {
  private readonly logger = new Logger(BanService.name);
  private readonly bannedCache = new Set<number>();
  private cacheLoaded = false;

  constructor(
    @InjectRepository(BannedUser)
    private bannedUserRepository: Repository<BannedUser>,
  ) {}

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    const banned = await this.bannedUserRepository.find();
    for (const b of banned) {
      this.bannedCache.add(b.userId);
    }
    this.cacheLoaded = true;
  }

  async isUserBanned(userId: number): Promise<boolean> {
    await this.loadCache();
    return this.bannedCache.has(userId);
  }

  async banUser(userId: number, reason?: string): Promise<BannedUser> {
    const existing = await this.bannedUserRepository.findOne({
      where: { userId },
    });
    if (existing) {
      this.logger.warn(`User ${userId} is already banned`);
      return existing;
    }

    const bannedUser = this.bannedUserRepository.create({
      userId,
      reason: reason || null,
      bannedAt: Date.now(),
    });
    const saved = await this.bannedUserRepository.save(bannedUser);
    this.bannedCache.add(userId);
    this.logger.log(`User ${userId} banned. Reason: ${reason || 'none'}`);
    return saved;
  }

  async unbanUser(userId: number): Promise<boolean> {
    const result = await this.bannedUserRepository.delete({ userId });
    this.bannedCache.delete(userId);
    const removed = (result.affected ?? 0) > 0;
    if (removed) {
      this.logger.log(`User ${userId} unbanned`);
    }
    return removed;
  }

  async listBannedUsers(): Promise<BannedUser[]> {
    return this.bannedUserRepository.find();
  }
}
