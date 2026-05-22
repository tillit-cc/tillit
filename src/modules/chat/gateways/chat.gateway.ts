import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import {
  forwardRef,
  Inject,
  Logger,
  OnModuleDestroy,
  Optional,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import { MessageService } from '../services/message.service';
import { RoomService } from '../services/room.service';
import { ChatEvents, MessageEnvelope } from '../interfaces/chat-events';
import { SendMessageDto, SendPacketDto, RoomIdDto } from '../dto/message.dto';
import { RedisConfigService } from '../../../config/database/redis/config.service';
import { isCloudMode } from '../../../config/deployment-mode';
import { SenderKeysService } from '../../sender-keys/services/sender-keys.service';
import { DeviceLinkService } from '../../../auth/services/device-link.service';
import { DeviceService } from '../../../auth/services/device.service';
import type { DeviceLinkNotifier } from '../../../auth/services/device-link.service';
import { v4 as uuidv4 } from 'uuid';
import type { AuthenticatedSocket } from '../../../common/types/authenticated-socket';

// Max WebSocket message payload size (64KB).
// Media must be uploaded via REST /media endpoints, not inline in messages.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

// Max WebSocket payload for volatile messages (10MB default).
// Volatile messages carry inline encrypted media (fire-and-forget, never stored).
const MAX_WS_VOLATILE_PAYLOAD_BYTES = parseInt(
  process.env.MAX_VOLATILE_PAYLOAD_BYTES || String(10 * 1024 * 1024),
  10,
);

@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN === 'true'
        ? true
        : process.env.CORS_ORIGIN
      : true,
    credentials: true,
  },
})
export class ChatGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);
  private redisPubClient?: RedisClientType;
  private redisSubClient?: RedisClientType;

  constructor(
    private messageService: MessageService,
    private roomService: RoomService,
    private senderKeysService: SenderKeysService,
    @Inject(forwardRef(() => DeviceLinkService))
    private deviceLinkService: DeviceLinkService,
    @Inject(forwardRef(() => DeviceService))
    private deviceService: DeviceService,
    @Optional() private redisConfig?: RedisConfigService,
  ) {}

  async onModuleDestroy() {
    if (this.redisPubClient) {
      this.redisPubClient.destroy();
    }
    if (this.redisSubClient) {
      this.redisSubClient.destroy();
    }
  }

  async afterInit(server: Server) {
    this.messageService.setServer(server);
    this.senderKeysService.setServer(server);

    // Wire the device-link broadcast hooks: device-link/device services
    // need to push `deviceLinked` / `deviceRevoked` / `senderKeysAvailable`
    // events over the live Socket.IO server, which only the gateway holds.
    const notifier: DeviceLinkNotifier = {
      notifyDeviceLinked: (primaryUserId, payload) => {
        server
          .to(`user:${primaryUserId}`)
          .emit(ChatEvents.DeviceLinked, payload);
      },
      notifyPeersDeviceRevoked: async (
        revokedUserId,
        revokedDeviceId,
        revokedAt,
      ) => {
        // Peers = users sharing at least one room with the revoked user.
        // Broadcast to each peer's per-user room so all their devices learn.
        const peerIds = await this.roomService.getPeerUserIds(revokedUserId);
        const event = {
          self: false,
          userId: revokedUserId,
          revokedDeviceId,
          revokedAt,
        };
        for (const peerId of peerIds) {
          server.to(`user:${peerId}`).emit(ChatEvents.DeviceRevoked, event);
        }
      },
      notifyPeersDeviceLinked: async (
        linkedUserId,
        addedDeviceId,
        linkedAt,
      ) => {
        // Symmetric to notifyPeersDeviceRevoked: signal peers that
        // `linkedUserId` has a new active device so they can invalidate
        // their client-side `(userId, deviceId)` cache and fan-out to it.
        const peerIds = await this.roomService.getPeerUserIds(linkedUserId);
        const event = { userId: linkedUserId, addedDeviceId, linkedAt };
        for (const peerId of peerIds) {
          server.to(`user:${peerId}`).emit(ChatEvents.PeerDeviceLinked, event);
        }
      },
      notifyDeviceItselfRevoked: async (userId, revokedDeviceId, revokedAt) => {
        const sockets = await server.fetchSockets();
        const targets = sockets.filter((s: any) => {
          const u = s.user;
          return u?.userId === userId && u?.deviceId === revokedDeviceId;
        });
        const payload = {
          self: true,
          revokedDeviceId,
          byUserId: userId,
          revokedAt,
        };
        for (const socket of targets) {
          (socket as any).emit(ChatEvents.DeviceRevoked, payload);
        }
      },
      disconnectDeviceSockets: async (userId, deviceId) => {
        const sockets = await server.fetchSockets();
        for (const socket of sockets) {
          const u = (socket as any).user;
          if (u?.userId === userId && u?.deviceId === deviceId) {
            (socket as any).disconnect(true);
          }
        }
      },
      notifyNewDeviceSenderKeys: (userId, deviceId, rooms) => {
        // Fire one event per room of interest. The new device queries
        // `GET /sender-keys/:roomId` in response.
        for (const r of rooms) {
          // Targeted emit — we don't know the socket id yet, but the device
          // joins per-user room on connect, so all sockets of this user
          // receive it. The client filters by its own deviceId.
          server.to(`user:${userId}`).emit(ChatEvents.SenderKeysAvailable, {
            roomId: r.roomId,
            recipientDeviceId: deviceId,
            count: r.count,
          });
        }
      },
    };
    this.deviceLinkService.setNotifier(notifier);
    this.deviceService.setNotifier(notifier);

    // Setup Redis adapter ONLY in CLOUD mode (multi-instance Socket.IO)
    // In SELFHOSTED mode, runs in single-instance mode without Redis
    if (isCloudMode() && this.redisConfig) {
      try {
        this.redisPubClient = createClient({
          socket: {
            host: this.redisConfig.host,
            port: this.redisConfig.port,
          },
          database: this.redisConfig.db,
          password: this.redisConfig.password || undefined,
        }) as RedisClientType;

        this.redisSubClient =
          this.redisPubClient.duplicate() as RedisClientType;

        await Promise.all([
          this.redisPubClient.connect(),
          this.redisSubClient.connect(),
        ]);

        const adapterTarget =
          typeof (server as any).adapter === 'function'
            ? server
            : (server as any).server;

        if (adapterTarget && typeof adapterTarget.adapter === 'function') {
          adapterTarget.adapter(
            createAdapter(this.redisPubClient, this.redisSubClient),
          );
          this.logger.log(
            'Redis adapter configured for Socket.IO (CLOUD mode)',
          );
        } else {
          this.logger.warn(
            'Socket.IO adapter API unavailable; running without Redis adapter',
          );
        }
      } catch (error) {
        this.logger.error('Failed to configure Redis adapter:', error);
        this.logger.warn(
          'Socket.IO running without Redis adapter (single instance mode)',
        );
      }
    } else {
      this.logger.log('Running in SELFHOSTED mode - Redis adapter disabled');
    }

    this.logger.log('Chat Gateway initialized');
  }

  async handleConnection(client: AuthenticatedSocket) {
    const userId: number = client.user?.userId;
    const deviceId: number = client.user?.deviceId ?? 1;
    this.logger.log(`Client connected: ${client.id}, User: ${userId}`);

    // Auto-join user's rooms and deliver pending messages
    if (userId) {
      try {
        // Join user-specific room for direct notifications
        void client.join(`user:${userId}`);
        this.logger.debug(`User ${userId} joined personal room`);

        const rooms = await this.roomService.getUserRooms(userId);
        for (const room of rooms) {
          void client.join(`room:${room.id}`);
          this.logger.debug(`User ${userId} auto-joined room ${room.id}`);

          // Deliver pending messages for this room — scoped to this device
          // so a different device of the same user doesn't drain its peer's
          // per-device ciphertext.
          await this.deliverPendingMessages(userId, deviceId, room.id, client);

          // Notify other members that this user came online
          // Only for rooms with sender keys enabled
          if (room.useSenderKeys) {
            this.server
              .to(`room:${room.id}`)
              .except(client.id)
              .emit(ChatEvents.UserOnline, {
                userId,
                roomId: room.id,
                timestamp: Date.now(),
              });
            this.logger.debug(
              `Notified room ${room.id} that user ${userId} came online`,
            );
          }
        }
      } catch (error) {
        this.logger.error('Error auto-joining rooms:', error);
      }
    }
  }

  /**
   * Deliver pending messages to user upon connection with ack confirmation.
   * Only removes messages that the client actually acknowledged.
   */
  private async deliverPendingMessages(
    userId: number,
    deviceId: number,
    roomId: number,
    socket: AuthenticatedSocket,
  ): Promise<void> {
    try {
      await this.messageService.deliverPendingToSocket(
        userId,
        roomId,
        socket,
        deviceId,
      );
    } catch (error) {
      this.logger.error(
        `Error delivering pending messages to user ${userId}:`,
        error,
      );
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.logger.log(
      `Client disconnected: ${client.id}, User: ${client.user?.userId}`,
    );
  }

  /**
   * Handle sendMessage event
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage(ChatEvents.SendMessage)
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SendMessageDto,
  ) {
    const userId: number = client.user?.userId;
    const deviceId: number = client.user?.deviceId ?? 1;

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      // Resolve volatile flag: source of truth is the envelope (message),
      // DTO top-level is an optional override for backward compat.
      const isVolatile =
        data.volatile === true || data.message?.volatile === true;

      // Reject oversized payloads.
      // Volatile messages carry inline encrypted media, so they get a higher limit.
      // Non-volatile media must use REST /media endpoints.
      const messageForSize = data.message ?? data.recipients;
      const payloadSize = Buffer.byteLength(JSON.stringify(messageForSize));
      const maxSize = isVolatile
        ? MAX_WS_VOLATILE_PAYLOAD_BYTES
        : MAX_WS_PAYLOAD_BYTES;

      if (payloadSize > maxSize) {
        this.logger.warn(
          `User ${userId} sent oversized message (${payloadSize} bytes, volatile=${isVolatile}), rejecting`,
        );
        return {
          error: `Message too large (${payloadSize} bytes). Max: ${maxSize} bytes.${!isVolatile ? ' Use /media endpoint for file uploads.' : ''}`,
        };
      }

      // Verify user is member of room
      const isMember = await this.roomService.isUserInRoom(data.roomId, userId);

      if (!isMember) {
        return { error: 'You are not a member of this room' };
      }

      // Multi-device fan-out path: caller supplied one ciphertext per
      // (targetUser, targetDevice). Server picks the right socket for each.
      if (data.recipients && data.recipients.length > 0) {
        const { delivered, messageId, timestamp } =
          await this.messageService.fanOutToRecipients(
            data.roomId,
            userId,
            deviceId,
            data.recipients,
            data.category,
            data.type,
            client.id,
            isVolatile,
            data.metadata,
            data.id,
          );
        return { success: true, delivered, messageId, timestamp };
      }

      if (!data.message) {
        return { error: 'Either `message` or `recipients` must be set' };
      }

      // Check if this is a sender key encrypted message
      const isSenderKeyMessage = data.category === 'senderkey_message';

      if (isSenderKeyMessage) {
        // Validate room supports sender keys
        const room = await this.roomService.getRoomById(data.roomId);
        if (!room.useSenderKeys) {
          return { error: 'Room does not support sender key messages' };
        }

        // Sender key message - broadcast single ciphertext to all room members
        const envelope: MessageEnvelope = {
          // backend-0016: honour the client-minted id when present so the
          // sender can correlate receipts; fall back to a server uuid.
          id: data.id ?? uuidv4(),
          roomId: data.roomId,
          senderId: userId, // CRITICAL: Include sender ID for decryption
          // Forwarded so the client can address libsignal's per-device
          // sender-key store with (senderId, deviceId) instead of hardcoding 1.
          senderDeviceId: deviceId,
          message: {
            ciphertext: data.message.payload?.ciphertext,
            distributionId: data.message.payload?.distributionId,
          },
          timestamp: new Date().toISOString(),
          category: 'senderkey_message',
          type: data.type,
          version: process.env.MESSAGE_VERSION || '0.0.1',
        };

        // Deliver to room members with ack (excludes only the sending device,
        // so the sender's OTHER devices receive the sender-key broadcast).
        const { delivered } = await this.messageService.deliverEnvelopeToRoom(
          data.roomId,
          userId,
          deviceId,
          ChatEvents.NewMessage,
          envelope,
          client.id,
          isVolatile,
        );

        return {
          success: true,
          delivered,
          messageId: envelope.id,
          timestamp: envelope.timestamp,
        };
      } else {
        // Pair-wise encryption - use existing logic
        const envelope = await this.messageService.sendToRoom(
          data.roomId,
          userId,
          deviceId,
          data.message,
          data.category,
          data.type,
          client.id, // Pass socket ID to exclude sender from broadcast
          isVolatile,
          data.id,
        );

        return {
          success: true,
          delivered: envelope.delivered,
          messageId: envelope.id,
          timestamp: envelope.timestamp,
        };
      }
    } catch (error) {
      this.logger.error('Error sending message:', error);
      return { error: 'Internal server error' };
    }
  }

  /**
   * Handle sendPacket event (control packets)
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage(ChatEvents.SendPacket)
  async handleSendPacket(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: SendPacketDto,
  ) {
    const userId: number = client.user?.userId;
    const deviceId: number = client.user?.deviceId ?? 1;

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      // Reject oversized payloads
      const payloadForSize = data.packet ?? data.recipients;
      const payloadSize = Buffer.byteLength(JSON.stringify(payloadForSize));
      if (payloadSize > MAX_WS_PAYLOAD_BYTES) {
        this.logger.warn(
          `User ${userId} sent oversized packet (${payloadSize} bytes), rejecting`,
        );
        return {
          error: `Packet too large (${payloadSize} bytes). Max: ${MAX_WS_PAYLOAD_BYTES} bytes.`,
        };
      }

      // Verify user is member of room
      const isMember = await this.roomService.isUserInRoom(data.roomId, userId);

      if (!isMember) {
        return { error: 'You are not a member of this room' };
      }

      // Per-device fan-out path: one packet per (userId, deviceId). Used for
      // device-targeted control packets like X3DH session establishment.
      if (data.recipients && data.recipients.length > 0) {
        const { delivered, packetId, timestamp } =
          await this.messageService.fanOutPacketToRecipients(
            data.roomId,
            userId,
            deviceId,
            data.recipients,
            client.id,
            data.volatile,
          );
        return { success: true, delivered, packetId, timestamp };
      }

      if (!data.packet) {
        return { error: 'Either `packet` or `recipients` must be set' };
      }

      // Legacy single-packet broadcast (exclude sender from broadcast)
      const packet = await this.messageService.sendControlPacket(
        data.roomId,
        userId,
        deviceId,
        data.packet,
        data.recipientIds,
        client.id, // Exclude sender from broadcast
        data.volatile,
      );

      return {
        success: true,
        packetId: packet.id,
        timestamp: packet.timestamp,
      };
    } catch (error) {
      this.logger.error('Error sending packet:', error);
      return { error: 'Internal server error' };
    }
  }

  /**
   * Handle joinRoom event
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage(ChatEvents.JoinRoom)
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: RoomIdDto,
  ) {
    const userId: number = client.user?.userId;

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      const roomId = data.roomId;

      // Verify user is member of room
      const isMember = await this.roomService.isUserInRoom(roomId, userId);

      if (!isMember) {
        return { error: 'You are not a member of this room' };
      }

      // Join Socket.IO room
      void client.join(`room:${roomId}`);
      this.logger.debug(`User ${userId} joined room ${roomId}`);

      // Notify other members
      this.messageService.broadcastToRoomMembers(
        roomId,
        ChatEvents.UserJoined,
        {
          userId,
          roomId: roomId,
          timestamp: new Date().toISOString(),
        },
      );

      return {
        success: true,
        roomId: roomId,
      };
    } catch (error) {
      this.logger.error('Error joining room:', error);
      return { error: 'Internal server error' };
    }
  }

  /**
   * Handle leaveRoom event
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage(ChatEvents.LeaveRoom)
  async handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: RoomIdDto,
  ) {
    const userId: number = client.user?.userId;

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      const roomId = data.roomId;

      // Verify user is member of room
      const isMember = await this.roomService.isUserInRoom(roomId, userId);

      if (!isMember) {
        return { error: 'You are not a member of this room' };
      }

      // Leave Socket.IO room
      void client.leave(`room:${roomId}`);
      this.logger.debug(`User ${userId} left room ${roomId}`);

      // Notify other members
      this.messageService.broadcastToRoomMembers(roomId, ChatEvents.UserLeft, {
        userId,
        roomId: roomId,
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        roomId: roomId,
      };
    } catch (error) {
      this.logger.error('Error leaving room:', error);
      return { error: 'Internal server error' };
    }
  }

  /**
   * Handle requestSenderKeys event - fetch pending sender key distributions
   */
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  @SubscribeMessage('requestSenderKeys')
  async handleRequestSenderKeys(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: RoomIdDto,
  ) {
    const userId: number = client.user?.userId;
    const deviceId: number = client.user?.deviceId ?? 1;

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      const distributions = await this.senderKeysService.getPendingSenderKeys(
        data.roomId,
        userId,
        deviceId,
      );

      // Emit sender keys to requesting client
      client.emit('senderKeysAvailable', {
        roomId: data.roomId,
        distributions,
      });

      return {
        success: true,
        count: distributions.length,
      };
    } catch (error) {
      this.logger.error('Error fetching sender keys:', error);
      return { error: 'Internal server error' };
    }
  }
}
