import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { SenderKeyDistribution } from '../../../entities/sender-key-distribution.entity';
import { SenderKeyMetadata } from '../../../entities/sender-key-metadata.entity';
import { Room } from '../../../entities/room.entity';
import { RoomUser } from '../../../entities/room-user.entity';

@Injectable()
export class SenderKeysService {
  private readonly logger = new Logger(SenderKeysService.name);
  private server: Server;

  constructor(
    @InjectRepository(SenderKeyDistribution)
    private distributionRepository: Repository<SenderKeyDistribution>,
    @InjectRepository(SenderKeyMetadata)
    private metadataRepository: Repository<SenderKeyMetadata>,
    @InjectRepository(Room)
    private roomRepository: Repository<Room>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
  ) {}

  /**
   * Set Socket.IO server instance
   */
  setServer(server: Server) {
    this.server = server;
  }

  /**
   * Initialize sender keys for a room.
   * Called when a room switches to sender key mode.
   */
  async initializeSenderKeys(roomId: number, userId: number): Promise<string> {
    // Verify user is a member
    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this room');
    }

    // Create new distribution ID
    const distributionId = this.generateDistributionId();

    // Deactivate any active distribution for this sender
    await this.metadataRepository.update(
      { roomId, senderUserId: userId, active: true },
      { active: false, rotatedAt: Date.now() },
    );

    // Save metadata
    const metadata = this.metadataRepository.create({
      roomId,
      distributionId,
      senderUserId: userId,
      createdBy: userId,
      active: true,
      createdAt: Date.now(),
    });
    await this.metadataRepository.save(metadata);

    // Update room
    await this.roomRepository.update(
      { id: roomId },
      {
        useSenderKeys: true,
      },
    );

    this.logger.log(
      `Initialized sender keys for room ${roomId}, distribution: ${distributionId}`,
    );
    return distributionId;
  }

  /**
   * Distribute sender key to other room members.
   * The client encrypts its own sender key with each member's pair-wise session.
   */
  async distributeSenderKey(
    roomId: number,
    senderUserId: number,
    distributionId: string,
    distributions: Array<{
      recipientUserId: number;
      encryptedSenderKey: string;
    }>,
  ): Promise<void> {
    // Verify membership
    const isMember = await this.roomUserRepository.findOne({
      where: { roomId, userId: senderUserId },
    });
    if (!isMember) {
      throw new ForbiddenException('User is not a member of this room');
    }

    const activeMetadata = await this.metadataRepository.findOne({
      where: {
        roomId,
        senderUserId,
        distributionId,
        active: true,
      },
    });

    if (!activeMetadata) {
      throw new ForbiddenException('Invalid distribution id for sender');
    }

    const recipientIds = distributions.map((dist) => dist.recipientUserId);
    const members = await this.roomUserRepository.find({
      where: { roomId, userId: In(recipientIds) },
    });
    const memberIdSet = new Set(members.map((m) => m.userId));

    const validDistributions = distributions.filter(
      (dist) =>
        dist.recipientUserId !== senderUserId &&
        memberIdSet.has(dist.recipientUserId),
    );

    if (validDistributions.length !== distributions.length) {
      throw new ForbiddenException(
        'One or more recipients are not room members',
      );
    }

    // Save all distributions
    const entities = validDistributions.map((dist) =>
      this.distributionRepository.create({
        roomId,
        senderUserId,
        distributionId,
        recipientUserId: dist.recipientUserId,
        encryptedSenderKey: dist.encryptedSenderKey,
        delivered: false,
        createdAt: Date.now(),
      }),
    );

    await this.distributionRepository.save(entities);
    this.logger.log(
      `Distributed sender key for user ${senderUserId} in room ${roomId} to ${validDistributions.length} recipients`,
    );

    // Notify recipients via WebSocket that new sender keys are available
    if (this.server) {
      for (const dist of validDistributions) {
        this.server
          .to(`user:${dist.recipientUserId}`)
          .emit('senderKeysAvailable', {
            roomId,
            senderUserId,
            distributionId,
          });
        this.logger.debug(
          `Notified user ${dist.recipientUserId} about new sender key`,
        );
      }
    }
  }

  /**
   * Retrieve pending sender keys for a user in a room.
   */
  async getPendingSenderKeys(
    roomId: number,
    recipientUserId: number,
  ): Promise<SenderKeyDistribution[]> {
    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId: recipientUserId },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this room');
    }

    const distributions = await this.distributionRepository.find({
      where: {
        roomId,
        recipientUserId,
        delivered: false,
      },
      order: { createdAt: 'ASC' },
    });

    this.logger.log(
      `Retrieved ${distributions.length} pending sender keys for user ${recipientUserId} in room ${roomId}`,
    );
    return distributions;
  }

  /**
   * Mark sender keys as delivered.
   */
  async markSenderKeysDelivered(
    recipientUserId: number,
    distributionIds: number[],
  ): Promise<void> {
    await this.distributionRepository.update(
      { id: In(distributionIds), recipientUserId },
      { delivered: true },
    );
  }

  /**
   * Rotate sender key (when a member leaves or for security).
   */
  async rotateSenderKey(roomId: number, userId: number): Promise<string> {
    const room = await this.roomRepository.findOne({ where: { id: roomId } });
    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this room');
    }

    // Deactivate current distribution
    await this.metadataRepository.update(
      { roomId, senderUserId: userId, active: true },
      { active: false, rotatedAt: Date.now() },
    );

    // Create new distribution
    const newDistributionId = this.generateDistributionId();
    const metadata = this.metadataRepository.create({
      roomId,
      distributionId: newDistributionId,
      senderUserId: userId,
      createdBy: userId,
      active: true,
      createdAt: Date.now(),
    });
    await this.metadataRepository.save(metadata);

    this.logger.log(
      `Rotated sender key for room ${roomId}, new distribution: ${newDistributionId}`,
    );
    return newDistributionId;
  }

  /**
   * Check if a room uses sender keys.
   */
  async shouldUseSenderKeys(roomId: number): Promise<boolean> {
    const room = await this.roomRepository.findOne({ where: { id: roomId } });
    return room?.useSenderKeys ?? false;
  }

  async getActiveDistributionForSender(
    roomId: number,
    senderUserId: number,
  ): Promise<string | null> {
    const metadata = await this.metadataRepository.findOne({
      where: { roomId, senderUserId, active: true },
      order: { createdAt: 'DESC' },
    });
    return metadata?.distributionId ?? null;
  }

  private generateDistributionId(): string {
    return uuidv4();
  }
}
