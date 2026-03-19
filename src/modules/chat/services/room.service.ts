import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Raw } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Room, RoomStatus } from '../../../entities/room.entity';
import { RoomUser } from '../../../entities/room-user.entity';
import { User } from '../../../entities/user.entity';
import { MediaBlob } from '../../../entities/media-blob.entity';
import { PendingMessage } from '../../../entities/pending-message.entity';
import { MediaConfigService } from '../../../config/media/config.service';
import { randomBytes } from 'crypto';

@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);
  constructor(
    @InjectRepository(Room)
    private roomRepository: Repository<Room>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(MediaBlob)
    private mediaBlobRepository: Repository<MediaBlob>,
    @InjectRepository(PendingMessage)
    private pendingMessageRepository: Repository<PendingMessage>,
    private mediaConfig: MediaConfigService,
    private dataSource: DataSource,
  ) {}

  /**
   * Generate default username for a room member
   * Format: "User N" where N is based on existing member count
   */
  private async generateDefaultUsername(roomId: number): Promise<string> {
    const memberCount = await this.roomUserRepository.count({
      where: { roomId },
    });
    return `User ${memberCount + 1}`;
  }

  /**
   * Generate a unique invite code for a room
   */
  private async generateInviteCode(): Promise<string> {
    let inviteCode: string = '';
    let isUnique = false;

    const codeLength = parseInt(process.env.INVITE_CODE_LENGTH || '8', 10);
    const bytesNeeded = Math.ceil((codeLength * 3) / 4);

    while (!isUnique) {
      inviteCode = randomBytes(bytesNeeded)
        .toString('base64url')
        .substring(0, codeLength)
        .toLowerCase();

      // Check if code already exists (case-insensitive for SQLite compat)
      const existingRoom = await this.roomRepository.findOne({
        where: {
          inviteCode: Raw((alias) => `LOWER(${alias}) = :code`, {
            code: inviteCode,
          }),
        },
      });

      if (!existingRoom) {
        isUnique = true;
      }
    }

    return inviteCode;
  }

  /**
   * Get room by invite code
   */
  async getRoomByInviteCode(inviteCode: string): Promise<Room> {
    const code = inviteCode.trim().toLowerCase();
    const room = await this.roomRepository.findOne({
      where: {
        inviteCode: Raw((alias) => `LOWER(${alias}) = :code`, { code }),
      },
    });
    if (!room) {
      this.logger.warn('Invalid invite code');
      throw new NotFoundException('Invalid invite code');
    }
    return room;
  }

  /**
   * Create a new room with an invite code
   */
  async createRoom(
    creatorUserId: number,
    name?: string,
    creatorUsername?: string,
    administered?: boolean,
  ): Promise<Room> {
    // Verify creator exists
    const creator = await this.userRepository.findOne({
      where: { id: creatorUserId },
    });
    if (!creator) {
      throw new NotFoundException('Creator user not found');
    }

    // Generate unique invite code
    const inviteCode = await this.generateInviteCode();

    // Create room
    const room = this.roomRepository.create({
      name: name || undefined,
      status: RoomStatus.CREATED,
      idUser: creatorUserId,
      inviteCode,
      administered: administered ?? false,
    });
    await this.roomRepository.save(room);

    // Add creator to room with default username if not provided
    const finalUsername =
      creatorUsername || (await this.generateDefaultUsername(room.id));
    const roomUser = this.roomUserRepository.create({
      roomId: room.id,
      userId: creatorUserId,
      username: finalUsername,
      joinedAt: Date.now(),
    });
    await this.roomUserRepository.save(roomUser);

    return room;
  }

  /**
   * Get room members by room ID
   * Returns User with username from room membership
   */
  async getRoomMembers(
    roomId: number,
  ): Promise<Array<User & { username?: string }>> {
    const room = await this.roomRepository.findOne({ where: { id: roomId } });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const memberships = await this.roomUserRepository.find({
      where: { roomId },
      relations: ['user'],
    });

    return memberships.map((membership) => ({
      ...membership.user,
      username: membership.username,
    }));
  }

  /**
   * Join room by invite code
   */
  async joinRoomByCode(
    inviteCode: string,
    userId: number,
    username?: string,
  ): Promise<{ room: Room; alreadyJoined: boolean }> {
    // Get room by invite code
    const room = await this.getRoomByInviteCode(inviteCode);

    // Check if user exists
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Check if a user is already a member
    const existingMembership = await this.roomUserRepository.findOne({
      where: { roomId: room.id, userId },
    });

    if (existingMembership) {
      // Already a member, update username if provided
      if (username && existingMembership.username !== username) {
        existingMembership.username = username;
        await this.roomUserRepository.save(existingMembership);
      }
      // Update room status to active if needed
      if (room.status !== RoomStatus.ACTIVE) {
        room.status = RoomStatus.ACTIVE;
        await this.roomRepository.save(room);
      }
      return { room, alreadyJoined: true };
    }

    // Add user to room with default username if not provided
    const finalUsername =
      username || (await this.generateDefaultUsername(room.id));
    const roomUser = this.roomUserRepository.create({
      roomId: room.id,
      userId,
      username: finalUsername,
      joinedAt: Date.now(),
    });
    await this.roomUserRepository.save(roomUser);

    // Update room status to active
    room.status = RoomStatus.ACTIVE;
    await this.roomRepository.save(room);

    return { room, alreadyJoined: false };
  }

  /**
   * Delete room and clean up associated media files from filesystem.
   * DB cascade handles room_users, pending_messages, media_blobs, media_downloads.
   */
  async deleteRoom(id: number): Promise<void> {
    // Clean up media files from filesystem before DB cascade deletes the records
    const mediaBlobs = await this.mediaBlobRepository.find({
      where: { roomId: id },
    });

    const storageDir = path.resolve(this.mediaConfig.storageDir);
    for (const blob of mediaBlobs) {
      const filePath = path.resolve(storageDir, blob.filePath);
      if (!filePath.startsWith(storageDir + path.sep)) {
        continue; // Skip path traversal attempts
      }
      try {
        await fs.promises.unlink(filePath);
      } catch (err) {
        this.logger.warn(
          `Failed to delete media file ${blob.filePath}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    // Delete room (cascade handles room_users, pending_messages, media_blobs)
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(RoomUser, { roomId: id });
      await manager.delete(Room, { id: id });
    });
  }

  /**
   * Leave an administered room.
   * Removes user from room_users and cleans up their pending messages.
   */
  async leaveRoom(roomId: number, userId: number): Promise<void> {
    await this.roomUserRepository.delete({ roomId, userId });
    await this.pendingMessageRepository.delete({ roomId, userId });
  }

  /**
   * Get all rooms for a user
   */
  async getUserRooms(userId: number): Promise<Room[]> {
    const roomUsers = await this.roomUserRepository.find({
      where: { userId },
      relations: ['room'],
    });

    return roomUsers.map((ru) => ru.room);
  }

  /**
   * Check if user is member of room (by room ID)
   */
  async isUserInRoom(roomId: number, userId: number): Promise<boolean> {
    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });

    return !!membership;
  }

  /**
   * Check if two users share at least one room
   */
  async usersShareRoom(userId1: number, userId2: number): Promise<boolean> {
    const shared = await this.roomUserRepository
      .createQueryBuilder('ru1')
      .innerJoin(RoomUser, 'ru2', 'ru1.roomId = ru2.roomId')
      .where('ru1.userId = :userId1', { userId1 })
      .andWhere('ru2.userId = :userId2', { userId2 })
      .limit(1)
      .getOne();
    return !!shared;
  }

  /**
   * Get room by ID
   */
  async getRoomById(roomId: number): Promise<Room> {
    const room = await this.roomRepository.findOne({ where: { id: roomId } });
    if (!room) {
      throw new NotFoundException('Room not found');
    }
    return room;
  }

  /**
   * Update room name
   */
  async updateRoomName(
    roomId: number,
    userId: number,
    newName: string,
  ): Promise<Room> {
    // Get room
    const room = await this.getRoomById(roomId);

    // Verify user is member of room
    const isMember = await this.isUserInRoom(roomId, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    // Update room name
    room.name = newName;
    await this.roomRepository.save(room);

    return room;
  }

  /**
   * Update member username in a room
   */
  async updateMemberUsername(
    roomId: number,
    userId: number,
    username: string,
  ): Promise<void> {
    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });

    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    membership.username = username;
    await this.roomUserRepository.save(membership);
  }
}
