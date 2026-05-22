import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RoomService } from './room.service';
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

  // backend-0015: in-flight fire-and-forget recipient deliveries. The sender
  // ack is decoupled from recipient delivery — a non-acking ("zombie")
  // recipient socket must never add its ACK_TIMEOUT to the sender's latency.
  // Tracked so graceful shutdown and tests can drain outstanding deliveries.
  private readonly backgroundDeliveries = new Set<Promise<unknown>>();

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
    @Inject(forwardRef(() => RoomService))
    private roomService: RoomService,
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
   * Normalize message envelope with metadata. `clientMessageId`, when
   * provided, becomes the envelope id — lets the sender correlate receipts
   * against the optimistic row it stored locally (backend-0016).
   */
  normalizeEnvelope(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    message: any,
    category?: string,
    type?: string,
    clientMessageId?: string,
  ): MessageEnvelope {
    return {
      id: clientMessageId ?? uuidv4(),
      roomId,
      senderId,
      senderDeviceId,
      message,
      timestamp: new Date().toISOString(),
      category: category || 'message',
      type: type || 'text',
      version: process.env.MESSAGE_VERSION || '0.0.1',
    };
  }

  /**
   * Send a user message to a room (backend-0015 — decoupled).
   *
   * Non-volatile: the relay accepts the envelope for routing and acks the
   * sender immediately. emitWithAck to recipients + `pending_messages`
   * fallback run fire-and-forget — a non-acking recipient socket can no
   * longer add ACK_TIMEOUT to the sender's latency. `delivered: true` here
   * means "accepted for relay"; the only consumer that reads `delivered`
   * (volatile-image UNDELIVERED UX) goes through the synchronous volatile
   * branch below.
   *
   * Volatile: kept synchronous so the sender learns whether anybody
   * received the one-off envelope (no offline queue exists for volatile
   * sends). Volatile sends are not a backlog source.
   */
  async sendToRoom(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    message: any,
    category?: string,
    type?: string,
    senderSocketId?: string,
    volatile?: boolean,
    clientMessageId?: string,
  ): Promise<MessageEnvelope & { delivered: boolean }> {
    const envelope = this.normalizeEnvelope(
      roomId,
      senderId,
      senderDeviceId,
      message,
      category,
      type,
      clientMessageId,
    );

    if (volatile) {
      const { ackedDeviceKeys, failedDeviceKeys } =
        await this.deliverToRoomWithAck(
          roomId,
          senderId,
          senderDeviceId,
          ChatEvents.NewMessage,
          envelope,
          senderSocketId,
        );
      this.logger.debug(
        `Volatile message ${envelope.id}: acked=${ackedDeviceKeys.size}, failed=${failedDeviceKeys.size}, skipping offline queue`,
      );
      return { ...envelope, delivered: ackedDeviceKeys.size > 0 };
    }

    this.deliverToRoomInBackground(
      roomId,
      senderId,
      senderDeviceId,
      ChatEvents.NewMessage,
      envelope,
      senderSocketId,
      false, // skipNotification
      false, // volatile
    );
    return { ...envelope, delivered: true };
  }

  /**
   * Send a control packet (backend-0015 — fully decoupled).
   *
   * The relay accepts the packet for routing and acks the sender
   * immediately. emitWithAck to recipients + `pending_messages` fallback
   * run fire-and-forget. Applies to both `recipientIds` (targeted) and the
   * room-broadcast branch, volatile or not. Control packets never push.
   *
   * @param senderSocketId - Optional socket ID to exclude sender from broadcast
   */
  sendControlPacket(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    packet: any,
    recipientIds?: number[],
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<ControlPacket> {
    const controlPacket: ControlPacket = {
      id: uuidv4(),
      roomId,
      senderId,
      senderDeviceId,
      packet,
      recipientIds,
      timestamp: new Date().toISOString(),
    };

    if (!this.server) {
      this.logger.warn('Socket server not initialized');
      return Promise.resolve(controlPacket);
    }

    if (recipientIds && recipientIds.length > 0) {
      this.runInBackground(`packet ${controlPacket.id}`, () =>
        this.deliverPacketToRecipientIds(
          controlPacket,
          roomId,
          recipientIds,
          volatile,
        ),
      );
    } else {
      this.deliverToRoomInBackground(
        roomId,
        senderId,
        senderDeviceId,
        ChatEvents.NewPacket,
        controlPacket,
        senderSocketId,
        true, // skipNotification — control packets never push
        volatile === true,
      );
    }

    return Promise.resolve(controlPacket);
  }

  /**
   * Deliver a control packet to a specific set of recipient users with
   * per-socket ack. Sockets of the same user are tried in parallel so one
   * dead socket can't delay delivery to the user's other (live) socket.
   * Recipients that don't ack on any socket are queued in `pending_messages`
   * (non-volatile only).
   */
  private async deliverPacketToRecipientIds(
    controlPacket: ControlPacket,
    roomId: number,
    recipientIds: number[],
    volatile?: boolean,
  ): Promise<void> {
    const sockets = await this.server.in(`room:${roomId}`).fetchSockets();

    await Promise.all(
      recipientIds.map(async (userId) => {
        const userSockets = sockets.filter(
          (s: any) => s.user?.userId === userId,
        );

        // Emit to every socket of the user in parallel — acked if any acks.
        // A dead socket enumerated first must not gate the live one.
        const results = await Promise.all(
          userSockets.map((socket) =>
            this.emitWithAck(socket, ChatEvents.NewPacket, controlPacket),
          ),
        );
        const acked = results.some(Boolean);

        if (!acked && !volatile) {
          await this.savePendingMessage(userId, roomId, controlPacket);
        }
      }),
    );
  }

  /**
   * Handle offline targets device-by-device (backend-0011). The set of
   * candidates is the room's active devices minus the sending device — so
   * the sender's OTHER devices are included (sender-key self fan-out).
   * Whatever didn't ack in this round gets a per-device pending row so a
   * reconnecting device only drains rows addressed to it.
   *
   * @param ackedDeviceKeys - Set of `"userId:deviceId"` that confirmed
   *   receipt in this round. Everyone else (except the sending device) is
   *   considered offline, including zombie sockets.
   * @param skipNotification - skip push notifications (control packets)
   */
  async handleOfflineUsers(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    envelope: MessageEnvelope | ControlPacket,
    ackedDeviceKeys?: Set<string>,
    skipNotification = false,
  ): Promise<void> {
    try {
      const activeDevices = await this.roomService.getActiveDevices(roomId);

      // Candidates = all active devices in the room minus the sending device.
      const candidates = activeDevices.filter(
        (d) => !(d.userId === senderId && d.deviceId === senderDeviceId),
      );

      if (candidates.length === 0) {
        return;
      }

      const acked = ackedDeviceKeys ?? new Set<string>();
      const offline = candidates.filter(
        (d) => !acked.has(`${d.userId}:${d.deviceId}`),
      );

      if (offline.length === 0) {
        this.logger.debug('All room devices confirmed receipt');
        return;
      }

      // One pending row per (userId, deviceId). The first reconnecting
      // device of the user must not drain rows targeted at sibling devices.
      await Promise.all(
        offline.map((d) =>
          this.savePendingMessage(d.userId, roomId, envelope, d.deviceId),
        ),
      );

      this.logger.log(
        `Stored message for ${offline.length} offline device(s)`,
      );

      // Push notifications: wake the user, not the device. Skip the sender's
      // own user (no self-push, mirrors fanOutToRecipients semantics).
      if (!skipNotification) {
        const offlineUserIds = Array.from(
          new Set(
            offline
              .map((d) => d.userId)
              .filter((userId) => userId !== senderId),
          ),
        );
        if (offlineUserIds.length > 0) {
          await this.sendPushNotificationsToUsers(
            roomId,
            senderId,
            envelope,
            offlineUserIds,
          );
        }
      }
    } catch (error) {
      this.logger.error('Error handling offline users:', error);
      // Don't throw - offline handling is best effort
    }
  }

  /**
   * Save pending message for offline user.
   * Volatile messages are already filtered upstream (sendToRoom / deliverEnvelopeToRoom).
   *
   * `recipientDeviceId` is set for fan-out envelopes (per-device ciphertext)
   * so a different device of the same user can't drain it on reconnect.
   * Legacy single-recipient paths leave it NULL — any device of the user
   * will fetch it (preserves v0.x behavior).
   */
  private async savePendingMessage(
    userId: number,
    roomId: number,
    envelope: MessageEnvelope | ControlPacket,
    recipientDeviceId: number | null = null,
  ): Promise<void> {
    const envelopeStr = JSON.stringify(envelope);
    const now = Date.now();
    const pendingMessage = this.pendingMessageRepository.create({
      id: uuidv4(),
      userId,
      recipientDeviceId,
      roomId,
      envelope: envelopeStr,
      createdAt: now,
      expiresAt: now + this.MESSAGE_TTL,
      attempts: 0,
    });

    await this.pendingMessageRepository.save(pendingMessage);
    this.logger.debug(
      `Saved pending message ${envelope.id} for user ${userId}` +
        (recipientDeviceId !== null ? ` device ${recipientDeviceId}` : ''),
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
   * Multi-device fan-out: deliver one envelope per (recipientUser, recipientDevice)
   * tuple. Each envelope carries the ciphertext that was encrypted specifically
   * for that device. Sockets that aren't listening get queued (per recipient)
   * in `pending_messages` so they receive their ciphertext when they reconnect.
   */
  async fanOutToRecipients(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    recipients: Array<{ userId: number; deviceId: number; ciphertext: any }>,
    category: string | undefined,
    type: string | undefined,
    senderSocketId?: string,
    volatile?: boolean,
    metadata?: { id_parent?: string; version?: string },
    clientMessageId?: string,
  ): Promise<{ delivered: boolean; messageId: string; timestamp: string }> {
    if (!this.server || recipients.length === 0) {
      return {
        delivered: false,
        messageId: clientMessageId ?? uuidv4(),
        timestamp: new Date().toISOString(),
      };
    }

    this.logger.debug(
      `fanOutToRecipients: room=${roomId} sender=${senderId}/${senderDeviceId} recipients=${recipients.length}`,
    );

    // backend-0016: use the client-minted id as envelope.id so the sender
    // can match incoming delivered/read receipts (id_message = envelope.id)
    // against its locally stored optimistic row.
    const baseId = clientMessageId ?? uuidv4();
    const timestamp = new Date().toISOString();
    const envelopeVersion =
      metadata?.version || process.env.MESSAGE_VERSION || '0.0.1';

    if (volatile) {
      // Volatile fan-out: synchronous so the sender learns `delivered`
      // (volatile has no offline queue). Never queues, never pushes.
      const delivered = await this.runFanOutMessageDelivery(
        baseId,
        timestamp,
        envelopeVersion,
        roomId,
        senderId,
        senderDeviceId,
        recipients,
        category,
        type,
        senderSocketId,
        true,
        metadata,
      );
      return { delivered, messageId: baseId, timestamp };
    }

    // Non-volatile: decouple (backend-0015). Accept now, fan out + queue +
    // push in the background. `delivered: true` = accepted for relay.
    this.runInBackground(`fanout ${baseId}`, () =>
      this.runFanOutMessageDelivery(
        baseId,
        timestamp,
        envelopeVersion,
        roomId,
        senderId,
        senderDeviceId,
        recipients,
        category,
        type,
        senderSocketId,
        false,
        metadata,
      ),
    );
    return { delivered: true, messageId: baseId, timestamp };
  }

  /**
   * Fan-out delivery body for `fanOutToRecipients` — emits one per-device
   * envelope, queues offline targets (non-volatile), and wakes offline
   * non-self users via push. Returns whether any device acked.
   */
  private async runFanOutMessageDelivery(
    baseId: string,
    timestamp: string,
    envelopeVersion: string,
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    recipients: Array<{ userId: number; deviceId: number; ciphertext: any }>,
    category: string | undefined,
    type: string | undefined,
    senderSocketId: string | undefined,
    volatile: boolean,
    metadata?: { id_parent?: string; version?: string },
  ): Promise<boolean> {
    const sockets = await this.server.in(`room:${roomId}`).fetchSockets();
    let anyAcked = false;
    // Track which recipient (user, device) failed so we can wake the user via
    // push without sending duplicate notifications.
    const offlineUserIds = new Set<number>();

    await Promise.all(
      recipients.map(async (rcp) => {
        const envelope: MessageEnvelope = {
          id: baseId,
          roomId,
          senderId,
          senderDeviceId,
          message: rcp.ciphertext,
          timestamp,
          category: category || 'message',
          type: type || 'text',
          version: envelopeVersion,
          ...(metadata?.id_parent ? { idParent: metadata.id_parent } : {}),
        };

        const targets = sockets.filter((s: any) => {
          const u = s.user;
          if (!u || u.userId !== rcp.userId || u.deviceId !== rcp.deviceId) {
            return false;
          }
          if (senderSocketId && s.id === senderSocketId) return false;
          return true;
        });

        let acked = false;
        for (const socket of targets) {
          const ok = await this.emitWithAck(
            socket,
            ChatEvents.NewMessage,
            envelope,
          );
          if (ok) {
            acked = true;
            break;
          }
        }

        if (acked) {
          anyAcked = true;
        } else if (!volatile) {
          // Offline (or zombie) device: queue the per-device ciphertext.
          // The envelope contains exactly the bytes this device needs to
          // decrypt — the next-best thing to live delivery.
          await this.savePendingMessage(
            rcp.userId,
            roomId,
            envelope,
            rcp.deviceId,
          );
          offlineUserIds.add(rcp.userId);
        }
      }),
    );

    if (!volatile && offlineUserIds.size > 0) {
      // Push notifications are user-scoped (one Expo token per device install,
      // all rows owned by `user_id`), so a single push wakes every device of
      // that user. Skip the sender's own user: writing from one device must
      // not notify our own other devices (WhatsApp/Signal Desktop semantics).
      const toNotify = [...offlineUserIds].filter((id) => id !== senderId);
      if (toNotify.length > 0) {
        const pushEnvelope: MessageEnvelope = {
          id: baseId,
          roomId,
          senderId,
          senderDeviceId,
          message: null,
          timestamp,
          category: category || 'message',
          type: type || 'text',
          version: envelopeVersion,
        };
        await this.sendPushNotificationsToUsers(
          roomId,
          senderId,
          pushEnvelope,
          toNotify,
        );
      }
    }

    return anyAcked;
  }

  /**
   * Multi-device fan-out for control packets: deliver one packet per
   * (recipientUser, recipientDevice). Mirrors `fanOutToRecipients` but for
   * `newPacket`. No push notifications — control packets never push.
   */
  fanOutPacketToRecipients(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    recipients: Array<{ userId: number; deviceId: number; packet: any }>,
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<{ delivered: boolean; packetId: string; timestamp: string }> {
    if (!this.server || recipients.length === 0) {
      return Promise.resolve({
        delivered: false,
        packetId: uuidv4(),
        timestamp: new Date().toISOString(),
      });
    }

    const baseId = uuidv4();
    const timestamp = new Date().toISOString();

    // Control packets always decouple sender ack from recipient delivery
    // (backend-0015), volatile or not. `delivered: true` = accepted for relay.
    this.runInBackground(`fanout-packet ${baseId}`, () =>
      this.runFanOutPacketDelivery(
        baseId,
        timestamp,
        roomId,
        senderId,
        senderDeviceId,
        recipients,
        senderSocketId,
        volatile,
      ),
    );
    return Promise.resolve({ delivered: true, packetId: baseId, timestamp });
  }

  /**
   * Fan-out delivery body for `fanOutPacketToRecipients` — one packet per
   * (userId, deviceId), with per-device pending queueing on miss. No push:
   * control packets never push.
   */
  private async runFanOutPacketDelivery(
    baseId: string,
    timestamp: string,
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    recipients: Array<{ userId: number; deviceId: number; packet: any }>,
    senderSocketId: string | undefined,
    volatile: boolean | undefined,
  ): Promise<void> {
    const sockets = await this.server.in(`room:${roomId}`).fetchSockets();

    await Promise.all(
      recipients.map(async (rcp) => {
        const controlPacket: ControlPacket = {
          id: baseId,
          roomId,
          senderId,
          senderDeviceId,
          packet: rcp.packet,
          recipientIds: [rcp.userId],
          timestamp,
        };

        const targets = sockets.filter((s: any) => {
          const u = s.user;
          if (!u || u.userId !== rcp.userId || u.deviceId !== rcp.deviceId) {
            return false;
          }
          if (senderSocketId && s.id === senderSocketId) return false;
          return true;
        });

        let acked = false;
        for (const socket of targets) {
          const ok = await this.emitWithAck(
            socket,
            ChatEvents.NewPacket,
            controlPacket,
          );
          if (ok) {
            acked = true;
            break;
          }
        }

        if (!acked && !volatile) {
          await this.savePendingMessage(
            rcp.userId,
            roomId,
            controlPacket,
            rcp.deviceId,
          );
        }
      }),
    );
  }

  /**
   * Deliver a pre-built envelope to room with ack-based delivery.
   * Used by sender key messages which construct their own envelope in the gateway.
   * `senderDeviceId` is required so the sender's OTHER devices receive the
   * broadcast (sender-key self fan-out, backend-0011).
   */
  async deliverEnvelopeToRoom(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    event: string,
    envelope: MessageEnvelope | ControlPacket,
    senderSocketId?: string,
    volatile?: boolean,
  ): Promise<{ delivered: boolean; ackedDeviceKeys: Set<string> }> {
    if (volatile) {
      // Volatile: synchronous so the sender learns `delivered` (no offline
      // queue exists for volatile sends).
      const { ackedDeviceKeys, failedDeviceKeys } =
        await this.deliverToRoomWithAck(
          roomId,
          senderId,
          senderDeviceId,
          event,
          envelope,
          senderSocketId,
        );
      this.logger.debug(
        `Volatile envelope ${envelope.id}: acked=${ackedDeviceKeys.size}, failed=${failedDeviceKeys.size}, skipping offline queue`,
      );
      return { delivered: ackedDeviceKeys.size > 0, ackedDeviceKeys };
    }

    // Non-volatile: decouple sender ack from recipient delivery (backend-0015).
    this.deliverToRoomInBackground(
      roomId,
      senderId,
      senderDeviceId,
      event,
      envelope,
      senderSocketId,
      false, // skipNotification
      false, // volatile
    );
    return { delivered: true, ackedDeviceKeys: new Set() };
  }

  /**
   * Deliver pending messages to a specific socket with ack confirmation.
   * Only deletes messages that were successfully acked by the client.
   *
   * `deviceId` scopes the fetch to per-device rows + legacy rows
   * (recipient_device_id IS NULL). Omit to deliver everything for the user
   * — used by tests and any caller that doesn't know the device.
   */
  async deliverPendingToSocket(
    userId: number,
    roomId: number,
    socket: any,
    deviceId?: number,
  ): Promise<number> {
    const pending = await this.getPendingMessages(userId, roomId, deviceId);

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
   * Deliver a message/packet to every socket in a room with per-socket ack.
   * Skips ONLY the sending device `(senderId, senderDeviceId)`; other devices
   * of the sender are legitimate recipients (sender-key self fan-out). Each
   * acked socket is keyed as `"userId:deviceId"` so two devices of the same
   * user are counted independently — needed for per-device offline queueing
   * downstream (backend-0011).
   */
  private async deliverToRoomWithAck(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    event: string,
    data: any,
    excludeSocketId?: string,
  ): Promise<{
    ackedDeviceKeys: Set<string>;
    failedDeviceKeys: Set<string>;
  }> {
    if (!this.server) {
      return { ackedDeviceKeys: new Set(), failedDeviceKeys: new Set() };
    }

    try {
      const sockets = await this.server.in(`room:${roomId}`).fetchSockets();

      const recipientSockets = sockets.filter((s: any) => {
        const userId = s.user?.userId;
        const deviceId = s.user?.deviceId ?? 1;
        if (userId === undefined) return false;
        // Exclude ONLY the sending device — the sender's OTHER devices are
        // legitimate recipients (sender-key self fan-out).
        if (userId === senderId && deviceId === senderDeviceId) return false;
        if (excludeSocketId && s.id === excludeSocketId) return false;
        return true;
      });

      if (recipientSockets.length === 0) {
        return { ackedDeviceKeys: new Set(), failedDeviceKeys: new Set() };
      }

      const results = await Promise.all(
        recipientSockets.map(async (socket: any) => {
          const userId: number = socket.user?.userId;
          const deviceId: number = socket.user?.deviceId ?? 1;
          const acked = await this.emitWithAck(socket, event, data);
          return { userId, deviceId, acked };
        }),
      );

      // Dedup by `userId:deviceId` (two devices = two slots; multiple
      // sockets of the same device collapse to one).
      const ackedDeviceKeys = new Set<string>();
      const failedDeviceKeys = new Set<string>();

      for (const { userId, deviceId, acked } of results) {
        const key = `${userId}:${deviceId}`;
        if (acked) {
          ackedDeviceKeys.add(key);
        } else {
          failedDeviceKeys.add(key);
        }
      }

      for (const key of ackedDeviceKeys) {
        failedDeviceKeys.delete(key);
      }

      this.logger.debug(
        `Room ${roomId} delivery: acked=${ackedDeviceKeys.size}, failed=${failedDeviceKeys.size}`,
      );

      return { ackedDeviceKeys, failedDeviceKeys };
    } catch (error) {
      this.logger.error('Error delivering with ack:', error);
      return { ackedDeviceKeys: new Set(), failedDeviceKeys: new Set() };
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
   * Run a recipient-delivery task fire-and-forget (backend-0015). The
   * promise is tracked so `awaitBackgroundDeliveries()` can drain it.
   * Errors are swallowed (logged) — a delivery failure must never reject
   * the caller, which has already acked the sender.
   */
  private runInBackground(label: string, task: () => Promise<unknown>): void {
    const tracked = task()
      .catch((error) => {
        this.logger.error(`Background delivery failed (${label}):`, error);
      })
      .finally(() => {
        this.backgroundDeliveries.delete(tracked);
      });
    this.backgroundDeliveries.add(tracked);
  }

  /**
   * Await all in-flight background deliveries. For graceful shutdown and
   * tests — not on the hot path.
   */
  async awaitBackgroundDeliveries(): Promise<void> {
    await Promise.allSettled([...this.backgroundDeliveries]);
  }

  /**
   * Fire-and-forget: deliver an envelope/packet to every socket in a room
   * with per-socket ack, then queue it for any recipient that didn't ack.
   * The sender has already been acked (backend-0015).
   *
   * @param skipNotification - skip push notifications (control packets)
   * @param volatile - skip the offline queue (no `pending_messages` row)
   */
  private deliverToRoomInBackground(
    roomId: number,
    senderId: number,
    senderDeviceId: number,
    event: string,
    envelope: MessageEnvelope | ControlPacket,
    senderSocketId: string | undefined,
    skipNotification: boolean,
    volatile: boolean,
  ): void {
    this.runInBackground(`room:${roomId} ${envelope.id}`, async () => {
      const { ackedDeviceKeys } = await this.deliverToRoomWithAck(
        roomId,
        senderId,
        senderDeviceId,
        event,
        envelope,
        senderSocketId,
      );
      if (volatile) {
        this.logger.debug(
          `Volatile envelope ${envelope.id}: skipping offline queue`,
        );
        return;
      }
      await this.handleOfflineUsers(
        roomId,
        senderId,
        senderDeviceId,
        envelope,
        ackedDeviceKeys,
        skipNotification,
      );
    });
  }

  /**
   * Get pending messages for a user in a specific room.
   *
   * When `deviceId` is provided, returns rows targeted at that device plus
   * legacy rows with `recipient_device_id IS NULL` (the v0.x broadcast
   * semantics). When omitted, returns every row for `(userId, roomId)`.
   */
  async getPendingMessages(
    userId: number,
    roomId: number,
    deviceId?: number,
  ): Promise<PendingMessage[]> {
    const where =
      deviceId !== undefined
        ? [
            { userId, roomId, recipientDeviceId: deviceId },
            { userId, roomId, recipientDeviceId: IsNull() },
          ]
        : { userId, roomId };

    return await this.pendingMessageRepository.find({
      where,
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
