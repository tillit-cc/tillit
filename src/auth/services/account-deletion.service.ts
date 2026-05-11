import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

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

export interface AccountDeletionStats {
  userId: number | null;
  rooms: number;
  messages: number;
  preKeys: number;
  senderKeyDistributions: number;
  pushTokens: number;
  reports: number;
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Room)
    private readonly roomRepo: Repository<Room>,
    @InjectRepository(RoomUser)
    private readonly roomUserRepo: Repository<RoomUser>,
    @InjectRepository(SignalKey)
    private readonly signalKeyRepo: Repository<SignalKey>,
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
    @InjectRepository(PendingMessage)
    private readonly pendingRepo: Repository<PendingMessage>,
    @InjectRepository(MediaBlob)
    private readonly mediaRepo: Repository<MediaBlob>,
    @InjectRepository(Report)
    private readonly reportRepo: Repository<Report>,
    @InjectRepository(SenderKeyDistribution)
    private readonly skdRepo: Repository<SenderKeyDistribution>,
    private readonly dataSource: DataSource,
    private readonly messageService: MessageService,
    private readonly banService: BanService,
    private readonly mediaConfig: MediaConfigService,
  ) {}

  /**
   * Permanently delete every server-side record tied to `userId`.
   *
   * The user record is the cascade root: deleting it triggers cascades on
   * room_users, signal_keys, push_tokens, sender_key_*, pending_messages
   * (where userId is the recipient), media_blobs, media_downloads,
   * user_devices, banned_users, and rooms the user created.
   *
   * Before deletion we:
   *  - broadcast `roomDeleted`/`userLeftRoom` so peers can update local state;
   *  - clean media files off disk (their DB rows are about to cascade away);
   *  - anonymise reports filed *against* this user (audit trail preserved);
   *  - delete the user's *outbound* pending messages (cascade only covers
   *    inbound ones, which key off pending_messages.userId = recipient).
   *
   * Idempotent: if `userId` no longer exists the call succeeds with zero stats.
   */
  async deleteAccount(userId: number): Promise<AccountDeletionStats> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      this.logger.log(
        `[Auth] Account deletion no-op (already gone): userId=${userId}`,
      );
      return this.emptyStats();
    }

    const { roomsToDelete, roomsToLeave, allRooms } =
      await this.classifyRooms(userId);

    const stats: AccountDeletionStats = {
      userId,
      rooms: allRooms.length,
      messages: 0,
      preKeys: await this.signalKeyRepo.count({ where: { userId } }),
      senderKeyDistributions: await this.skdRepo
        .createQueryBuilder('skd')
        .where('skd.sender_user_id = :userId', { userId })
        .orWhere('skd.recipient_user_id = :userId', { userId })
        .getCount(),
      pushTokens: await this.pushTokenRepo.count({ where: { userId } }),
      reports: await this.reportRepo.count({
        where: { reporterUserId: userId },
      }),
    };

    const senderPendingIds = await this.findOutboundPendingIds(
      userId,
      allRooms.map((r) => r.id),
    );
    const recipientPendingCount = await this.pendingRepo.count({
      where: { userId },
    });
    stats.messages = senderPendingIds.length + recipientPendingCount;

    const mediaToDeleteOnDisk = await this.collectMediaForCleanup(
      userId,
      roomsToDelete.map((r) => r.id),
    );

    this.broadcastDeletionEvents(userId, roomsToDelete, roomsToLeave);

    await this.cleanupMediaFiles(mediaToDeleteOnDisk);

    await this.dataSource.transaction(async (manager) => {
      // Preserve audit trail for reports filed against this user — set the
      // FK to NULL instead of letting cascade wipe them.
      await manager.update(
        Report,
        { reportedUserId: userId },
        { reportedUserId: null },
      );

      if (senderPendingIds.length > 0) {
        await manager.delete(PendingMessage, senderPendingIds);
      }

      // Rooms not owned by the user (sole-member orphans) need explicit
      // cleanup; rooms owned by the user cascade-delete via rooms.id_user.
      const orphanRoomIds = roomsToDelete
        .filter((r) => r.idUser !== userId)
        .map((r) => r.id);
      if (orphanRoomIds.length > 0) {
        await manager.delete(Room, orphanRoomIds);
      }

      await manager.delete(User, userId);
    });

    // The banned_users row cascaded with the user; this just clears the
    // in-memory cache so a future identity reusing the same key isn't
    // mistakenly blocked.
    await this.banService.unbanUser(userId);

    this.logger.log(
      `[Auth] Account deleted: userId=${userId}, rooms=${stats.rooms}, messages=${stats.messages}`,
    );

    return stats;
  }

  private async classifyRooms(userId: number): Promise<{
    allRooms: Room[];
    roomsToDelete: Room[];
    roomsToLeave: Room[];
  }> {
    const memberships = await this.roomUserRepo.find({ where: { userId } });
    const roomIds = memberships.map((m) => m.roomId);
    if (roomIds.length === 0) {
      return { allRooms: [], roomsToDelete: [], roomsToLeave: [] };
    }

    const allRooms = await this.roomRepo.find({ where: { id: In(roomIds) } });

    const counts = await this.roomUserRepo
      .createQueryBuilder('ru')
      .select('ru.room_id', 'roomId')
      .addSelect('COUNT(*)', 'count')
      .where('ru.room_id IN (:...roomIds)', { roomIds })
      .groupBy('ru.room_id')
      .getRawMany<{ roomId: number; count: string | number }>();

    const memberCount = new Map<number, number>();
    for (const c of counts) {
      memberCount.set(Number(c.roomId), Number(c.count));
    }

    const roomsToDelete: Room[] = [];
    const roomsToLeave: Room[] = [];
    for (const r of allRooms) {
      const willCascadeFromCreator = r.idUser === userId;
      const isSoleMember = (memberCount.get(r.id) ?? 0) <= 1;
      if (willCascadeFromCreator || isSoleMember) {
        roomsToDelete.push(r);
      } else {
        roomsToLeave.push(r);
      }
    }

    return { allRooms, roomsToDelete, roomsToLeave };
  }

  private async findOutboundPendingIds(
    userId: number,
    roomIds: number[],
  ): Promise<string[]> {
    if (roomIds.length === 0) return [];
    const pending = await this.pendingRepo.find({
      where: { roomId: In(roomIds) },
    });
    const ids: string[] = [];
    for (const m of pending) {
      try {
        const env = JSON.parse(m.envelope) as { senderId?: number };
        if (env?.senderId === userId) {
          ids.push(m.id);
        }
      } catch {
        // Malformed envelope — leave it for the normal TTL cleanup.
      }
    }
    return ids;
  }

  private async collectMediaForCleanup(
    userId: number,
    deletedRoomIds: number[],
  ): Promise<MediaBlob[]> {
    const owned = await this.mediaRepo.find({ where: { uploaderId: userId } });
    const inDeletedRooms =
      deletedRoomIds.length > 0
        ? await this.mediaRepo.find({
            where: { roomId: In(deletedRoomIds) },
          })
        : [];

    const dedup = new Map<string, MediaBlob>();
    for (const b of [...owned, ...inDeletedRooms]) {
      dedup.set(b.id, b);
    }
    return [...dedup.values()];
  }

  private broadcastDeletionEvents(
    userId: number,
    roomsToDelete: Room[],
    roomsToLeave: Room[],
  ): void {
    const timestamp = Date.now();

    for (const r of roomsToDelete) {
      this.messageService.broadcastToRoomMembers(r.id, ChatEvents.RoomDeleted, {
        roomId: r.id,
        deletedBy: userId,
        timestamp,
      });
    }

    for (const r of roomsToLeave) {
      this.messageService.broadcastToRoomMembers(
        r.id,
        ChatEvents.UserLeftRoom,
        { roomId: r.id, userId, timestamp },
      );
    }
  }

  private async cleanupMediaFiles(blobs: MediaBlob[]): Promise<void> {
    if (blobs.length === 0) return;
    const storageDir = path.resolve(this.mediaConfig.storageDir);
    for (const blob of blobs) {
      const filePath = path.resolve(storageDir, blob.filePath);
      if (!filePath.startsWith(storageDir + path.sep)) {
        continue;
      }
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        this.logger.warn(
          `Failed to delete media file ${blob.filePath}: ${msg}`,
        );
      }
    }
  }

  private emptyStats(): AccountDeletionStats {
    return {
      userId: null,
      rooms: 0,
      messages: 0,
      preKeys: 0,
      senderKeyDistributions: 0,
      pushTokens: 0,
      reports: 0,
    };
  }
}
