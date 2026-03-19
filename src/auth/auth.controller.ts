import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { IdentityAuthDto } from './dto/identity-auth.dto';
import { ChallengeRequestDto, ChallengeResponse } from './dto/challenge.dto';
import { RegisterPushTokenDto } from './dto/push-token.dto';
import { ChallengeStore } from './services/challenge.store';
import type { AuthenticatedRequest } from '../common/types/authenticated-request';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly challengeStore: ChallengeStore,
  ) {}

  /**
   * POST /auth/challenge
   * Request a challenge nonce for identity authentication
   * Client must sign this nonce with their private key
   */
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_AUTH_LIMIT || '5', 10),
    },
  })
  @Post('challenge')
  async requestChallenge(
    @Body() dto: ChallengeRequestDto,
  ): Promise<ChallengeResponse> {
    const { challengeId, nonce } = await this.challengeStore.createChallenge(
      dto.identityPublicKey,
    );

    return {
      challengeId,
      nonce,
      expiresIn: parseInt(process.env.CHALLENGE_TTL_SECONDS || '60', 10),
    };
  }

  /**
   * POST /auth/identity
   * Authenticate by Signal Protocol identity key
   * Requires valid challenge signature to prove private key possession
   * Creates new user if not exists, returns JWT token
   */
  @Throttle({
    default: {
      ttl: 60000,
      limit: parseInt(process.env.THROTTLE_AUTH_LIMIT || '5', 10),
    },
  })
  @Post('identity')
  async authenticateByIdentity(@Body() dto: IdentityAuthDto) {
    const result = await this.authService.authenticateByIdentity(dto);

    return {
      accessToken: result.accessToken,
      userId: result.userId,
      isNewUser: result.isNewUser,
      ...(result.banned && { banned: true }),
    };
  }

  /**
   * POST /auth/loadtest
   * Simplified auth for load testing — skips signature verification.
   * Only available when LOADTEST_MODE=true env var is set.
   */
  @Post('loadtest')
  async authenticateLoadtest(@Body() dto: IdentityAuthDto) {
    if (process.env.LOADTEST_MODE !== 'true') {
      throw new BadRequestException('Loadtest mode is not enabled');
    }
    const result = await this.authService.authenticateLoadtest(dto);

    return {
      accessToken: result.accessToken,
      userId: result.userId,
      isNewUser: result.isNewUser,
    };
  }

  /**
   * GET /auth/status
   * Check if the server is reachable and the user can interact with it.
   * Called by the app on startup and on every reopen.
   * Protected by JwtAuthGuard — returns 401 with error 'BANNED' if banned,
   * standard 401 if token is invalid/missing, or { status: 'ok' } if valid.
   */
  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * GET /auth/token/refresh
   * Refresh JWT token
   */
  @UseGuards(JwtAuthGuard)
  @Get('token/refresh')
  async refreshToken(@Request() req: AuthenticatedRequest) {
    const result = await this.authService.refreshToken(req.user.userId);

    return {
      accessToken: result.accessToken,
    };
  }

  /**
   * POST /auth/token/push
   * Register push notification token (Expo or Firebase)
   */
  @UseGuards(JwtAuthGuard)
  @Post('token/push')
  async registerPushToken(
    @Request() req: AuthenticatedRequest,
    @Body() pushTokenDto: RegisterPushTokenDto,
  ) {
    await this.authService.registerPushToken(
      req.user.userId,
      pushTokenDto.token,
      pushTokenDto.platform,
      pushTokenDto.provider,
      pushTokenDto.lang,
    );

    return {
      message: 'Push token registered successfully',
    };
  }

  /**
   * GET /auth/v1/users/me
   * Get current authenticated user
   */
  @UseGuards(JwtAuthGuard)
  @Get('v1/users/me')
  async getCurrentUser(@Request() req: AuthenticatedRequest) {
    const user = await this.authService.getUserById(req.user.userId);

    return {
      id: user.id,
      identityPublicKey: user.identityPublicKey,
      createdAt: user.createdAt,
    };
  }
}
