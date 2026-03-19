import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { RoomUser } from '../../../entities/room-user.entity';
import { PushToken } from '../../../entities/push-token.entity';
import { PendingMessage } from '../../../entities/pending-message.entity';
import { ExpoNotificationService } from '../../../services/expo-notification.service';
import { PushRelayService } from '../../../services/push-relay.service';
import { CloudWorkerConfigService } from '../../../config/cloud-worker/config.service';
import { isSelfHostedMode } from '../../../config/deployment-mode';
import {
  MessageEnvelope,
  ControlPacket,
  ChatEvents,
} from '../interfaces/chat-events';

@Injectable()
export class MessageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageService.name);
  private server: Server;
  private cleanupInterval: NodeJS.Timeout;

  // TTL for pending messages (default: 7 days)
  private readonly MESSAGE_TTL = parseInt(
    process.env.PENDING_MESSAGE_TTL_MS || '604800000',
    10,
  );

  // Timeout for Socket.IO acknowledgment (ms)
  // If client doesn't ack within this time, treat as offline (zombie socket)
  private readonly ACK_TIMEOUT = parseInt(
    process.env.ACK_TIMEOUT_MS || '5000',
    10,
  );

  constructor(
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
    @InjectRepository(PushToken)
    private pushTokenRepository: Repository<PushToken>,
    @InjectRepository(PendingMessage)
    private pendingMessageRepository: Repository<PendingMessage>,
    private expoNotificationService: ExpoNotificationService,
    private pushRelayService: PushRelayService,
    private cloudWorkerConfig: CloudWorkerConfigService,
  ) {}

  onModuleInit() {
    const interval = parseInt(
      process.env.PENDING_CLEANUP_INTERVAL_MS || '3600000',
      10,
    );
    this.cleanupInterval = setInterval(() => {
      void this.cleanupExpiredMessages();
    }, interval);
    this.logger.log(`Pending message cleanup scheduled (every ${interval}ms)`);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  /**
   * Set Socket.IO server instance
   */
  setServer(server: Server) {
    this.server = server;
  }

  /**
   * Normalize message envelope with metadata
   */
  normalizeEnvelope(
    roomId: number,
    senderId: number,
    message: any,
    category?: string,
    type?: string,
  ): MessageEnvelope {
    return {
      id: uuidv4(),
      roomId,
      senderId,
      message,
      timestamp: new Date().toISOString(),
      category: category || 'message',
      type: type || 'text',
      version: process.env.MESSAGE_VERSION || '0.0.1',
    };
  }

  /**
   * Send message to room with ack-based delivery confirmation.
   *
   * Instead of broadcasting and hoping, we emit to each socket individually
   * with a timeout. If a client doesn't ack in time (zombie socket / app in
   * standby), it is treated as offline.
   *
   * @param volatile - If true, skip offline queue for failed deliveries
   * @returns envelope + delivered flag (true if at least one recipient acked)
   */
  async sendToRoom(
    roomId: number,
    senderId: number,
    message: any,
    category?: string,
    type?: string,
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<MessageEnvelope & { delivered: boolean }> {
    const envelope = this.normalizeEnvelope(
      roomId,
      senderId,
      message,
      category,
      type,
    );

    // Deliver with ack to each recipient socket
    const { ackedUserIds, failedUserIds } = await this.deliverToRoomWithAck(
      roomId,
      senderId,
      ChatEvents.NewMessage,
      envelope,
      senderSocketId,
    );

    const delivered = ackedUserIds.length > 0;

    if (volatile) {
      this.logger.debug(
        `Volatile message ${envelope.id}: acked=${ackedUserIds.length}, failed=${failedUserIds.length}, skipping offline queue`,
      );
    } else {
      // Queue for truly offline users + zombie sockets that didn't ack
      await this.handleOfflineUsers(roomId, senderId, envelope, ackedUserIds);
    }

    return { ...envelope, delivered };
  }

  /**
   * Send control packet to room or specific users, with ack-based delivery.
   * @param senderSocketId - Optional socket ID to exclude sender from broadcast
   */
  async sendControlPacket(
    roomId: number,
    senderId: number,
    packet: any,
    recipientIds?: number[],
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<ControlPacket> {
    const controlPacket: ControlPacket = {
      id: uuidv4(),
      roomId,
      senderId,
      packet,
      recipientIds,
      timestamp: new Date().toISOString(),
    };

    if (!this.server) {
      this.logger.warn('Socket server not initialized');
      return controlPacket;
    }

    if (recipientIds && recipientIds.length > 0) {
      // Send to specific users with ack
      const sockets = await this.server.in(`room:${roomId}`).fetchSockets();

      for (const userId of recipientIds) {
        const userSockets = sockets.filter(
          (s: any) => s.user?.userId === userId,
        );

        let acked = false;
        for (const socket of userSockets) {
          acked = await this.emitWithAck(
            socket,
            ChatEvents.NewPacket,
            controlPacket,
          );
          if (acked) break;
        }

        if (!acked && !volatile) {
          await this.savePendingMessage(userId, roomId, controlPacket);
        }
      }
    } else {
      // Send to entire room with ack
      const { ackedUserIds } = await this.deliverToRoomWithAck(
        roomId,
        senderId,
        ChatEvents.NewPacket,
        controlPacket,
        senderSocketId,
      );

      if (volatile) {
        this.logger.debug(
          `Volatile control packet ${controlPacket.id}: skipping offline queue`,
        );
      } else {
        // Queue for offline/zombie users (skip push for control packets)
        await this.handleOfflineUsers(
          roomId,
          senderId,
          controlPacket,
          ackedUserIds,
          true, // skipNotification
        );
      }
    }

    return controlPacket;
  }

  /**
   * Handle offline users: store messages and send push notifications.
   *
   * @param ackedUserIds - Users who confirmed receipt via ack. Everyone else
   *   (except sender) is considered offline, including zombie sockets.
   * @param skipNotification - If true, skip push notifications (e.g., for control packets)
   */
  async handleOfflineUsers(
    roomId: number,
    senderId: number,
    envelope: MessageEnvelope | ControlPacket,
    ackedUserIds?: number[],
    skipNotification = false,
  ): Promise<void> {
    try {
      // Get all room members except sender
      const roomUsers = await this.roomUserRepository.find({
        where: { roomId },
      });

      const recipientIds = roomUsers
        .map((ru) => ru.userId)
        .filter((id) => id !== senderId);

      if (recipientIds.length === 0) {
        return;
      }

      // Offline = everyone except sender and acked users
      const confirmedOnline = ackedUserIds ?? [];
      const offlineUserIds = recipientIds.filter(
        (id) => !confirmedOnline.includes(id),
      );

      if (offlineUserIds.length === 0) {
        this.logger.debug('All room members confirmed receipt');
        return;
      }

      // Store message for each offline user
      await Promise.all(
        offlineUserIds.map((userId) =>
          this.savePendingMessage(userId, roomId, envelope),
        ),
      );

      this.logger.log(
        `Stored message for ${offlineUserIds.length} offline/unresponsive users`,
      );

      // Send push notifications (skip for control packets)
      if (!skipNotification) {
        await this.sendPushNotificationsToUsers(
          roomId,
          senderId,
          envelope,
          offlineUserIds,
        );
      }
    } catch (error) {
      this.logger.error('Error handling offline users:', error);
      // Don't throw - offline handling is best effort
    }
  }

  /**
   * Save pending message for offline user.
   * Volatile messages are already filtered upstream (sendToRoom / deliverEnvelopeToRoom).
   */
  private async savePendingMessage(
    userId: number,
    roomId: number,
    envelope: MessageEnvelope | ControlPacket,
  ): Promise<void> {
    const envelopeStr = JSON.stringify(envelope);
    const now = Date.now();
    const pendingMessage = this.pendingMessageRepository.create({
      id: uuidv4(),
      userId,
      roomId,
      envelope: envelopeStr,
      createdAt: now,
      expiresAt: now + this.MESSAGE_TTL,
      attempts: 0,
    });

    await this.pendingMessageRepository.save(pendingMessage);
    this.logger.debug(
      `Saved pending message ${envelope.id} for user ${userId}`,
    );
  }

  /**
   * Send push notifications to specific offline users.
   *
   * Dual-mode:
   * - Cloud mode: direct Expo SDK
   * - Self-hosted + cloud worker configured: PushRelayService (no EXPO_ACCESS_TOKEN needed)
   * - Self-hosted without cloud worker + EXPO_ACCESS_TOKEN: fallback to direct Expo SDK
   */
  private async sendPushNotificationsToUsers(
    roomId: number,
    senderId: number,
    envelope: MessageEnvelope | ControlPacket,
    offlineUserIds: number[],
  ): Promise<void> {
    try {
      if (offlineUserIds.length === 0) {
        return;
      }

      // Get push tokens for offline users (include lang field)
      const tokens = await this.pushTokenRepository.find({
        where: offlineUserIds.map((userId) => ({ userId })),
      });

      if (tokens.length === 0) {
        this.logger.debug('No push tokens found for offline users');
        return;
      }

      const pushData = this.cloudWorkerConfig.pushIncludeData
        ? {
            roomId: roomId.toString(),
            messageId: envelope.id,
            senderId: senderId.toString(),
          }
        : undefined;

      if (isSelfHostedMode() && this.pushRelayService.isConfigured()) {
        // Self-hosted with cloud worker: use relay (i18n via lang)
        await this.pushRelayService.sendNotification(
          tokens.map((t) => ({ token: t.token, lang: t.lang || 'en' })),
          pushData,
        );
      } else {
        // Cloud mode or self-hosted fallback with EXPO_ACCESS_TOKEN
        await this.expoNotificationService.sendNotification(
          tokens.map((t) => t.token),
          {
            title: 'New message',
            body: 'You have a new message',
            data: pushData,
          },
        );
      }

      this.logger.log(
        `Push notifications sent to ${tokens.length} offline users`,
      );
    } catch (error) {
      this.logger.error('Error sending push notifications:', error);
      // Don't throw - push notifications are best effort
    }
  }

  /**
   * Deliver a pre-built envelope to room with ack-based delivery.
   * Used by sender key messages which construct their own envelope in the gateway.
   */
  async deliverEnvelopeToRoom(
    roomId: number,
    senderId: number,
    event: string,
    envelope: MessageEnvelope | ControlPacket,
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<{ delivered: boolean; ackedUserIds: number[] }> {
    const { ackedUserIds, failedUserIds } = await this.deliverToRoomWithAck(
      roomId,
      senderId,
      event,
      envelope,
      senderSocketId,
    );

    const delivered = ackedUserIds.length > 0;

    if (volatile) {
      this.logger.debug(
        `Volatile envelope ${envelope.id}: acked=${ackedUserIds.length}, failed=${failedUserIds.length}, skipping offline queue`,
      );
    } else {
      await this.handleOfflineUsers(roomId, senderId, envelope, ackedUserIds);
    }

    return { delivered, ackedUserIds };
  }

  /**
   * Deliver pending messages to a specific socket with ack confirmation.
   * Only deletes messages that were successfully acked by the client.
   */
  async deliverPendingToSocket(
    userId: number,
    roomId: number,
    socket: any,
  ): Promise<number> {
    const pending = await this.getPendingMessages(userId, roomId);

    if (pending.length === 0) return 0;

    this.logger.log(
      `Delivering ${pending.length} pending messages to user ${userId} in room ${roomId}`,
    );

    let deliveredCount = 0;

    for (const msg of pending) {
      try {
        const envelope = JSON.parse(msg.envelope);
        const event =
          'packet' in envelope ? ChatEvents.NewPacket : ChatEvents.NewMessage;

        const acked = await this.emitWithAck(socket, event, envelope);

        if (acked) {
          await this.deletePendingMessage(msg.id);
          deliveredCount++;
        } else {
          this.logger.warn(
            `Client didn't ack pending message ${msg.id}, keeping in queue`,
          );
        }
      } catch (error) {
        this.logger.error(`Error delivering pending message ${msg.id}:`, error);
      }
    }

    this.logger.log(
      `Delivered ${deliveredCount}/${pending.length} pending messages to user ${userId}`,
    );

    return deliveredCount;
  }

  /**
   * Emit to a single socket with ack confirmation.
   * Returns true if client acked within timeout, false otherwise (zombie socket).
   */
  private emitWithAck(
    socket: any,
    event: string,
    data: any,
    timeoutMs = this.ACK_TIMEOUT,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      socket.emit(event, data, () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  /**
   * Deliver a message/packet to all sockets in a room with per-socket ack.
   * Returns which users acked and which didn't.
   */
  private async deliverToRoomWithAck(
    roomId: number,
    senderId: number,
    event: string,
    data: any,
    excludeSocketId?: string,
  ): Promise<{ ackedUserIds: number[]; failedUserIds: number[] }> {
    if (!this.server) {
      return { ackedUserIds: [], failedUserIds: [] };
    }

    try {
      const sockets = await this.server.in(`room:${roomId}`).fetchSockets();

      // Filter out sender
      const recipientSockets = sockets.filter((s: any) => {
        const userId = s.user?.userId;
        if (userId === undefined || userId === senderId) return false;
        if (excludeSocketId && s.id === excludeSocketId) return false;
        return true;
      });

      if (recipientSockets.length === 0) {
        return { ackedUserIds: [], failedUserIds: [] };
      }

      // Emit to each socket with ack
      const results = await Promise.all(
        recipientSockets.map(async (socket: any) => {
          const userId: number = socket.user?.userId;
          const acked = await this.emitWithAck(socket, event, data);
          return { userId, acked };
        }),
      );

      // Deduplicate by userId (a user may have multiple sockets)
      const ackedSet = new Set<number>();
      const failedSet = new Set<number>();

      for (const { userId, acked } of results) {
        if (acked) {
          ackedSet.add(userId);
        } else {
          failedSet.add(userId);
        }
      }

      // If user acked on any socket, remove from failed
      for (const userId of ackedSet) {
        failedSet.delete(userId);
      }

      const ackedUserIds = [...ackedSet];
      const failedUserIds = [...failedSet];

      this.logger.debug(
        `Room ${roomId} delivery: acked=${ackedUserIds.length}, failed=${failedUserIds.length}`,
      );

      return { ackedUserIds, failedUserIds };
    } catch (error) {
      this.logger.error('Error delivering with ack:', error);
      return { ackedUserIds: [], failedUserIds: [] };
    }
  }

  /**
   * Broadcast event to room members (fire-and-forget, no ack).
   * Used for non-critical events like userJoined, userLeft.
   */
  broadcastToRoomMembers(roomId: number, event: string, data: any): void {
    if (this.server) {
      this.server.to(`room:${roomId}`).emit(event, data);
    }
  }

  /**
   * Get pending messages for a user in a specific room
   */
  async getPendingMessages(
    userId: number,
    roomId: number,
  ): Promise<PendingMessage[]> {
    return await this.pendingMessageRepository.find({
      where: { userId, roomId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Get all pending messages for a user across all rooms
   */
  async getAllPendingMessages(userId: number): Promise<PendingMessage[]> {
    return await this.pendingMessageRepository.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Delete pending messages after successful delivery
   */
  async deletePendingMessages(userId: number, roomId: number): Promise<void> {
    await this.pendingMessageRepository.delete({ userId, roomId });
    this.logger.debug(
      `Deleted pending messages for user ${userId} in room ${roomId}`,
    );
  }

  /**
   * Delete a specific pending message
   */
  async deletePendingMessage(messageId: string): Promise<void> {
    await this.pendingMessageRepository.delete({ id: messageId });
  }

  /**
   * Cleanup expired pending messages
   * Should be called periodically (e.g., daily via cron job)
   */
  async cleanupExpiredMessages(): Promise<number> {
    const now = Date.now();
    const result = await this.pendingMessageRepository
      .createQueryBuilder()
      .delete()
      .where('expires_at < :now', { now })
      .execute();

    const deletedCount = result.affected || 0;
    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} expired pending messages`);
    }

    return deletedCount;
  }
}
