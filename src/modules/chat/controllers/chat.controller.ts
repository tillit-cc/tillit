import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  Put,
  Logger,
  ForbiddenException,
  NotFoundException,
  ParseIntPipe,
} from '@nestjs/common';
import { RoomService } from '../services/room.service';
import { MessageService } from '../services/message.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { ChatEvents } from '../interfaces/chat-events';
import {
  CreateRoomDto,
  JoinRoomDto,
  UpdateRoomDto,
  UpdateProfileDto,
} from '../dto/room.dto';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name);
  constructor(
    private readonly roomService: RoomService,
    private readonly messageService: MessageService,
  ) {}

  /**
   * PUT /chat
   * Create new room and generate invite code
   */
  @Put()
  async createRoom(
    @Request() req: AuthenticatedRequest,
    @Body() createRoomDto: CreateRoomDto,
  ) {
    const room = await this.roomService.createRoom(
      req.user.userId,
      createRoomDto.name,
      createRoomDto.username,
      createRoomDto.administered,
    );

    return {
      inviteCode: room.inviteCode,
      id: room.inviteCode, // For app compatibility
      roomId: room.id, // Internal ID for websocket
      name: room.name,
      status: room.status,
      id_user: room.idUser,
      administered: room.administered,
      createdAt: room.createdAt,
    };
  }

  /**
   * POST /chat/:code
   * Join room using invite code
   */
  @Post(':code')
  async joinRoom(
    @Param('code') inviteCode: string,
    @Request() req: AuthenticatedRequest,
    @Body() joinRoomDto?: JoinRoomDto,
  ) {
    const { room, alreadyJoined } = await this.roomService.joinRoomByCode(
      inviteCode,
      req.user.userId,
      joinRoomDto?.username,
    );

    return {
      id: room.inviteCode, // App expects invite code as id
      inviteCode: room.inviteCode,
      roomId: room.id, // Internal ID for websocket
      name: room.name,
      status: room.status,
      id_user: room.idUser,
      administered: room.administered,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      alreadyJoined,
    };
  }

  /**
   * GET /chat/rooms/:id
   * Get single room metadata by ID
   */
  @Get('rooms/:id')
  async getRoomMetadata(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const room = await this.roomService.getRoomById(id);

    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(id, req.user.userId);

    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    return {
      id: room.id,
      inviteCode: room.inviteCode,
      name: room.name,
      status: room.status,
      idUser: room.idUser,
      useSenderKeys: room.useSenderKeys,
      administered: room.administered,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  /**
   * GET /chat/:code/members
   * Get room members by invite code
   */
  @Get(':id/members')
  async getRoomMembers(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: AuthenticatedRequest,
  ) {
    // Get room by invite code
    const room = await this.roomService.getRoomById(id);

    // Verify user is member of room
    const isMember = await this.roomService.isUserInRoom(
      room.id,
      req.user.userId,
    );

    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const members = await this.roomService.getRoomMembers(room.id);

    this.logger.debug(
      `Room ${room.id} members before filter: ${JSON.stringify(members.map((u) => ({ id: u.id })))}`,
    );
    this.logger.debug(`Current user ID: ${req.user.userId}`);

    const filteredMembers = members.filter(
      (user) => user.id !== req.user.userId,
    );

    this.logger.debug(
      `Room ${room.id} members after filter: ${JSON.stringify(filteredMembers.map((u) => ({ id: u.id })))}`,
    );

    return {
      roomId: room.id,
      inviteCode: room.inviteCode,
      members: filteredMembers.map((user) => ({
        id: user.id,
        id_user: user.id,
        username: user.username,
      })),
    };
  }

  /**
   * PUT /chat/:id/profile
   * Update current user's profile in a room (username, etc.)
   */
  @Put(':id/profile')
  async updateProfile(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: AuthenticatedRequest,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    const room = await this.roomService.getRoomById(id);

    const isMember = await this.roomService.isUserInRoom(
      room.id,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    // Update username if provided
    if (updateProfileDto.username !== undefined) {
      await this.roomService.updateMemberUsername(
        room.id,
        req.user.userId,
        updateProfileDto.username,
      );
    }

    // Future: handle other profile fields here

    return {
      success: true,
      ...updateProfileDto,
    };
  }

  /**
   * DELETE /chat/:id
   * - Non-administered room: any member deletes the room (roomDeleted broadcast)
   * - Administered room + admin: deletes the room (roomDeleted broadcast)
   * - Administered room + non-admin: leaves the room (userLeftRoom broadcast)
   */
  @Delete(':id')
  async deleteRoom(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: AuthenticatedRequest,
  ) {
    // Check room exists first — avoids masking 404 as 403
    const room = await this.roomService.getRoomById(id).catch(() => null);
    if (!room) {
      throw new NotFoundException('Room not found');
    }

    const userId = req.user.userId;
    const isMember = await this.roomService.isUserInRoom(id, userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    // Administered room + non-admin → leave only
    if (room.administered && room.idUser !== userId) {
      // Broadcast BEFORE removing — so the leaving user still sees the event
      this.messageService.broadcastToRoomMembers(id, ChatEvents.UserLeftRoom, {
        roomId: id,
        userId,
        timestamp: Date.now(),
      });

      await this.roomService.leaveRoom(id, userId);

      return {
        message: 'Left room successfully',
        action: 'left',
        id,
      };
    }

    // Non-administered or admin → delete entire room
    // Broadcast BEFORE delete — after delete the Socket.IO room members are gone
    this.messageService.broadcastToRoomMembers(id, ChatEvents.RoomDeleted, {
      roomId: id,
      deletedBy: userId,
      timestamp: Date.now(),
    });

    await this.roomService.deleteRoom(id);

    return {
      message: 'Room deleted successfully',
      action: 'deleted',
      id,
    };
  }

  /**
   * PUT /chat/:id
   * Update room properties (name, etc.)
   */
  @Put(':id')
  async updateRoom(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: AuthenticatedRequest,
    @Body() updateRoomDto: UpdateRoomDto,
  ) {
    // Update room name if provided
    if (updateRoomDto.name !== undefined) {
      const updatedRoom = await this.roomService.updateRoomName(
        id,
        req.user.userId,
        updateRoomDto.name,
      );

      // Broadcast 'room_renamed' system message to all room members
      await this.messageService.sendToRoom(
        id,
        req.user.userId,
        {
          newName: updateRoomDto.name,
          updatedBy: req.user.userId,
        },
        'system',
        'room_renamed',
      );

      return {
        id: updatedRoom.id,
        inviteCode: updatedRoom.inviteCode,
        name: updatedRoom.name,
        status: updatedRoom.status,
        id_user: updatedRoom.idUser,
        createdAt: updatedRoom.createdAt,
        updatedAt: updatedRoom.updatedAt,
      };
    }

    // If no fields to update, just return the room (with membership check)
    const room = await this.roomService.getRoomById(id);
    const isMember = await this.roomService.isUserInRoom(id, req.user.userId);
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }
    return {
      id: room.id,
      inviteCode: room.inviteCode,
      name: room.name,
      status: room.status,
      id_user: room.idUser,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }

  /**
   * DELETE /chat/:roomId/message/:messageId
   * Delete a message from a room (broadcasts to all members)
   */
  @Delete(':roomId/message/:messageId')
  async deleteMessage(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Param('messageId') messageId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const isMember = await this.roomService.isUserInRoom(
      roomId,
      req.user.userId,
    );
    if (!isMember) {
      throw new ForbiddenException('You are not a member of this room');
    }

    await this.messageService.sendToRoom(
      roomId,
      req.user.userId,
      { message_id: messageId },
      'system',
      'message_deleted',
    );

    return { success: true, messageId };
  }

  /**
   * GET /chat
   * Get all rooms for current user with metadata
   */
  @Get()
  async getUserRooms(@Request() req: AuthenticatedRequest) {
    const rooms = await this.roomService.getUserRooms(req.user.userId);

    return {
      rooms: rooms.map((room) => ({
        id: room.id,
        inviteCode: room.inviteCode,
        name: room.name,
        status: room.status,
        idUser: room.idUser,
        useSenderKeys: room.useSenderKeys,
        administered: room.administered,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      })),
    };
  }
}
