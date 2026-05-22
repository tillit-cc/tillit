import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { DeviceLinkService } from './services/device-link.service';
import { DeviceService } from './services/device.service';
import {
  CompleteLinkDto,
  DeviceListResponse,
  DeviceRevokeResponse,
  InitLinkDto,
  LinkCompleteResponse,
  LinkInitResponse,
  LinkResultResponse,
  LinkSharePubkeyResponse,
  SharePubkeyDto,
} from './dto/device-link.dto';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';

@Controller('auth/devices')
export class DevicesController {
  constructor(
    private readonly deviceLinkService: DeviceLinkService,
    private readonly deviceService: DeviceService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/init  (anonymous — the new device starts here)
  //
  // Per-IP rate limit is the first line of defence against the anonymous
  // endpoint. A global soft cap on open `waiting` sessions lives inside
  // DeviceLinkService.initLink as the second line.
  // ──────────────────────────────────────────────────────────────────────────
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_AUTH_LIMIT || '5', 10),
    },
  })
  @Post('link/init')
  async initLink(@Body() dto: InitLinkDto): Promise<LinkInitResponse> {
    return this.deviceLinkService.initLink(dto);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/share-pubkey  (primary JWT, wire v2.1)
  //
  // Symmetric safety-number gate — the primary publishes `P_pub` to the
  // session ahead of /complete so the new device can compute its own SN
  // before any commit. See ADR
  // `_shared/decisions/0004-symmetric-safety-number.md`.
  // ──────────────────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Post('link/share-pubkey')
  async sharePubkey(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SharePubkeyDto,
  ): Promise<LinkSharePubkeyResponse> {
    return this.deviceLinkService.sharePubkey(
      req.user.userId,
      req.user.deviceId,
      dto,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST /auth/devices/link/complete  (primary JWT)
  // ──────────────────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Post('link/complete')
  async completeLink(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CompleteLinkDto,
  ): Promise<LinkCompleteResponse> {
    return this.deviceLinkService.completeLink(
      req.user.userId,
      req.user.deviceId,
      dto,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /auth/devices/link/session/:sessionId/result  (anon, one-time-use)
  // ──────────────────────────────────────────────────────────────────────────
  @Get('link/session/:sessionId/result')
  async getLinkResult(
    @Param('sessionId') sessionId: string,
  ): Promise<LinkResultResponse> {
    return this.deviceLinkService.getLinkResult(sessionId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET /auth/devices  (primary-only)
  // ──────────────────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Get()
  async listDevices(
    @Request() req: AuthenticatedRequest,
  ): Promise<DeviceListResponse> {
    return this.deviceService.listDevices(req.user.userId, req.user.deviceId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /auth/devices/me  (self-logout, any device)
  // Must come before the parameterized :id route to win the match.
  // ──────────────────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async revokeSelf(
    @Request() req: AuthenticatedRequest,
  ): Promise<DeviceRevokeResponse> {
    return this.deviceService.revokeSelf(req.user.userId, req.user.deviceId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /auth/devices/:id  (primary-only)
  // ──────────────────────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async revokeDevice(
    @Param('id', ParseIntPipe) deviceId: number,
    @Request() req: AuthenticatedRequest,
  ): Promise<DeviceRevokeResponse> {
    return this.deviceService.revokeDevice(
      req.user.userId,
      req.user.deviceId,
      deviceId,
    );
  }
}
