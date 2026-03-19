import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Request,
  Put,
  ParseIntPipe,
} from '@nestjs/common';
import { SenderKeysService } from '../services/sender-keys.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import {
  DistributeSenderKeyDto,
  MarkDeliveredDto,
} from '../dto/sender-keys.dto';
import type { AuthenticatedRequest } from '../../../common/types/authenticated-request';

@Controller('sender-keys')
@UseGuards(JwtAuthGuard)
export class SenderKeysController {
  constructor(private readonly senderKeysService: SenderKeysService) {}

  /**
   * POST /sender-keys/initialize/:roomId
   * Initialize sender keys for a room
   */
  @Post('initialize/:roomId')
  async initializeSenderKeys(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const distributionId = await this.senderKeysService.initializeSenderKeys(
      roomId,
      req.user.userId,
    );

    return {
      success: true,
      distributionId,
    };
  }

  /**
   * POST /sender-keys/distribute/:roomId
   * Distribute sender key to other room members
   */
  @Post('distribute/:roomId')
  async distributeSenderKey(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Request() req: AuthenticatedRequest,
    @Body() dto: DistributeSenderKeyDto,
  ) {
    await this.senderKeysService.distributeSenderKey(
      roomId,
      req.user.userId,
      dto.distributionId,
      dto.distributions,
    );

    return { success: true };
  }

  /**
   * PUT /sender-keys/mark-delivered
   * Mark sender keys as delivered
   */
  @Put('mark-delivered')
  async markDelivered(
    @Request() req: AuthenticatedRequest,
    @Body() body: MarkDeliveredDto,
  ) {
    await this.senderKeysService.markSenderKeysDelivered(
      req.user.userId,
      body.distributionIds,
    );
    return { success: true };
  }

  /**
   * GET /sender-keys/active/:roomId
   * Get active distribution ID for the current sender.
   * NOTE: Must be defined before :roomId to avoid routing conflicts.
   */
  @Get('active/:roomId')
  async getActiveDistribution(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const distributionId =
      await this.senderKeysService.getActiveDistributionForSender(
        roomId,
        req.user.userId,
      );

    return {
      distributionId,
    };
  }

  /**
   * GET /sender-keys/:roomId
   * Retrieve pending sender keys for the current room.
   * NOTE: Must be defined after more specific routes (active/:roomId).
   */
  @Get(':roomId')
  async getPendingSenderKeys(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const distributions = await this.senderKeysService.getPendingSenderKeys(
      roomId,
      req.user.userId,
    );

    return {
      distributions: distributions.map((d) => ({
        id: d.id,
        senderUserId: d.senderUserId,
        distributionId: d.distributionId,
        encryptedSenderKey: d.encryptedSenderKey,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * POST /sender-keys/rotate/:roomId
   * Rotate sender key for the room
   */
  @Post('rotate/:roomId')
  async rotateSenderKey(
    @Param('roomId', ParseIntPipe) roomId: number,
    @Request() req: AuthenticatedRequest,
  ) {
    const newDistributionId = await this.senderKeysService.rotateSenderKey(
      roomId,
      req.user.userId,
    );

    return {
      success: true,
      distributionId: newDistributionId,
    };
  }
}
