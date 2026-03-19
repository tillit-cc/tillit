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

          // Deliver pending messages for this room
          await this.deliverPendingMessages(userId, room.id, client);

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
    roomId: number,
    socket: AuthenticatedSocket,
  ): Promise<void> {
    try {
      await this.messageService.deliverPendingToSocket(userId, roomId, socket);
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
      const payloadSize = Buffer.byteLength(JSON.stringify(data.message));
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
          id: uuidv4(),
          roomId: data.roomId,
          senderId: userId, // CRITICAL: Include sender ID for decryption
          message: {
            ciphertext: data.message.payload?.ciphertext,
            distributionId: data.message.payload?.distributionId,
          },
          timestamp: new Date().toISOString(),
          category: 'senderkey_message',
          type: data.type,
          version: process.env.MESSAGE_VERSION || '0.0.1',
        };

        // Deliver to room members with ack (excludes sender)
        const { delivered } = await this.messageService.deliverEnvelopeToRoom(
          data.roomId,
          userId,
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
          data.message,
          data.category,
          data.type,
          client.id, // Pass socket ID to exclude sender from broadcast
          isVolatile,
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

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      // Reject oversized payloads
      const payloadSize = Buffer.byteLength(JSON.stringify(data.packet));
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

      // Send control packet (exclude sender from broadcast)
      const packet = await this.messageService.sendControlPacket(
        data.roomId,
        userId,
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

    if (!userId) {
      return { error: 'Unauthorized' };
    }

    try {
      const distributions = await this.senderKeysService.getPendingSenderKeys(
        data.roomId,
        userId,
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
