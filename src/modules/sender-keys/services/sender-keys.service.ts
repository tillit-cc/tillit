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
    senderDeviceId: number,
    distributionId: string,
    distributions: Array<{
      recipientUserId: number;
      recipientDeviceId?: number;
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

    const validDistributions = distributions.filter((dist) => {
      // Pairing-time self-distribution: a sender CAN distribute to their
      // own other devices (so a freshly linked device can decrypt the
      // sender's existing group messages). Filter out self only when
      // targeting the same device.
      const isSelfSameDevice =
        dist.recipientUserId === senderUserId &&
        (dist.recipientDeviceId ?? null) === senderDeviceId;
      return !isSelfSameDevice && memberIdSet.has(dist.recipientUserId);
    });

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
        senderDeviceId,
        distributionId,
        recipientUserId: dist.recipientUserId,
        recipientDeviceId: dist.recipientDeviceId ?? null,
        encryptedSenderKey: dist.encryptedSenderKey,
        delivered: false,
        createdAt: Date.now(),
      }),
    );

    await this.distributionRepository.save(entities);
    this.logger.log(
      `Distributed sender key for user ${senderUserId} in room ${roomId} to ${validDistributions.length} recipients`,
    );

    // Notify recipients via WebSocket that new sender keys are available.
    // When the distribution targets a specific device, narrow the emit so
    // peers on other devices of the same user don't get a spurious wake-up.
    if (this.server) {
      const sockets = await this.server.fetchSockets();
      for (const dist of validDistributions) {
        const payload = {
          roomId,
          senderUserId,
          senderDeviceId,
          distributionId,
          recipientDeviceId: dist.recipientDeviceId ?? null,
        };
        if (dist.recipientDeviceId != null) {
          const targets = sockets.filter((s: any) => {
            const u = s.user;
            return (
              u?.userId === dist.recipientUserId &&
              u?.deviceId === dist.recipientDeviceId
            );
          });
          for (const s of targets) {
            (s as any).emit('senderKeysAvailable', payload);
          }
        } else {
          this.server
            .to(`user:${dist.recipientUserId}`)
            .emit('senderKeysAvailable', payload);
        }
        this.logger.debug(
          `Notified user ${dist.recipientUserId} (device ${dist.recipientDeviceId ?? 'any'}) about new sender key`,
        );
      }
    }
  }

  /**
   * Retrieve pending sender keys for a user in a room.
   *
   * When `recipientDeviceId` is provided, narrow the result to rows targeted
   * at this device (or null = legacy single-device rows) so a freshly linked
   * device doesn't sweep up distributions meant for its sibling devices.
   */
  async getPendingSenderKeys(
    roomId: number,
    recipientUserId: number,
    recipientDeviceId?: number,
  ): Promise<SenderKeyDistribution[]> {
    const membership = await this.roomUserRepository.findOne({
      where: { roomId, userId: recipientUserId },
    });
    if (!membership) {
      throw new ForbiddenException('User is not a member of this room');
    }

    const qb = this.distributionRepository
      .createQueryBuilder('d')
      .where('d.room_id = :roomId', { roomId })
      .andWhere('d.recipient_user_id = :recipientUserId', { recipientUserId })
      .andWhere('d.delivered = :delivered', { delivered: false })
      .orderBy('d.created_at', 'ASC');
    if (recipientDeviceId != null) {
      qb.andWhere(
        '(d.recipient_device_id = :recipientDeviceId OR d.recipient_device_id IS NULL)',
        { recipientDeviceId },
      );
    }
    const distributions = await qb.getMany();

    this.logger.log(
      `Retrieved ${distributions.length} pending sender keys for user ${recipientUserId} (device ${recipientDeviceId ?? 'any'}) in room ${roomId}`,
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
