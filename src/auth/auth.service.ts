import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PublicKey } from '@signalapp/libsignal-client';
import { User } from '../entities/user.entity';
import { PushToken, PushProvider } from '../entities/push-token.entity';
import { SignalKey, KeyTypeId } from '../entities/signal-key.entity';
import { JwtConfigService } from '../config/jwt/config.service';
import { IdentityAuthDto, IdentityAuthResponse } from './dto/identity-auth.dto';
import { ChallengeStore } from './services/challenge.store';
import { AuthHostService } from './services/auth-host.service';
import { BanService } from '../modules/ban/ban.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(PushToken)
    private pushTokenRepository: Repository<PushToken>,
    @InjectRepository(SignalKey)
    private signalKeyRepository: Repository<SignalKey>,
    private jwtService: JwtService,
    private jwtConfig: JwtConfigService,
    private challengeStore: ChallengeStore,
    private authHostService: AuthHostService,
    private banService: BanService,
  ) {}

  /**
   * Authenticate user by Signal Protocol identity key
   * Creates new user if not exists, returns JWT token
   *
   * Security: Verifies challenge signature to prove private key possession.
   * The signature is bound to `expectedHost` via the v1 domain separator —
   * see `_shared/api/auth-challenge-domain-separation.md`.
   */
  async authenticateByIdentity(
    dto: IdentityAuthDto,
    expectedHost: string,
  ): Promise<IdentityAuthResponse> {
    // 1. Verify challenge signature (proof of private key possession)
    await this.verifyChallengeSignature(dto, expectedHost);

    // 2. Look for existing user by identity public key
    let user = await this.userRepository.findOne({
      where: { identityPublicKey: dto.identityPublicKey },
    });

    let isNewUser = false;
    let banned = false;

    if (!user) {
      // 3. Create new user
      user = this.userRepository.create({
        identityPublicKey: dto.identityPublicKey,
        registrationId: dto.registrationId,
      });
      await this.userRepository.save(user);
      isNewUser = true;
    } else {
      // 3b. Check if existing user is banned
      banned = await this.banService.isUserBanned(user.id);

      // 4. Existing user - verify consistency
      if (user.registrationId !== dto.registrationId) {
        throw new ConflictException(
          'Identity mismatch: registrationId does not match existing user',
        );
      }
    }

    // 5. Save/update signed pre-key (skip for banned users)
    if (!banned) {
      await this.saveSignedPreKey(user.id, dto);
    }

    // 6. Generate JWT (carries deviceId so server can forward it on
    // sender-key flows without an extra DB lookup per message)
    const accessToken = this.generateToken(user, dto.deviceId);

    return {
      accessToken,
      userId: user.id,
      isNewUser,
      ...(banned && { banned: true }),
    };
  }

  /**
   * Simplified auth for load testing — skips signature verification.
   * Creates user if not exists, returns JWT. No challenge needed.
   */
  async authenticateLoadtest(
    dto: IdentityAuthDto,
  ): Promise<IdentityAuthResponse> {
    let user = await this.userRepository.findOne({
      where: { identityPublicKey: dto.identityPublicKey },
    });

    let isNewUser = false;

    if (!user) {
      user = this.userRepository.create({
        identityPublicKey: dto.identityPublicKey,
        registrationId: dto.registrationId,
      });
      await this.userRepository.save(user);
      isNewUser = true;
    }

    await this.saveSignedPreKey(user.id, dto);
    const accessToken = this.generateToken(user, dto.deviceId);

    return { accessToken, userId: user.id, isNewUser };
  }

  /**
   * Verify challenge signature using Signal Protocol's libsignal.
   *
   * The signed payload is NOT the raw nonce: it is the v1 domain-separated
   * message `utf8("TilliT-Auth-Challenge-v1\n" + expectedHost + "\n") || nonceBytes`.
   * This prevents a malicious or compromised server from choosing a nonce that
   * doubles as a SignedPreKey body and replaying the resulting signature on a
   * different host. `nonceBytes` is the server's own emitted nonce — recovered
   * from the challenge store, never reconstructed from a client-supplied value.
   *
   * Throws if signature is invalid or challenge expired/not found.
   */
  private async verifyChallengeSignature(
    dto: IdentityAuthDto,
    expectedHost: string,
  ): Promise<void> {
    // 1. Consume challenge (one-time use)
    const challenge = await this.challengeStore.consumeChallenge(
      dto.challengeId,
    );

    if (!challenge) {
      throw new BadRequestException('Invalid or expired challenge');
    }

    // 2. Verify identity key matches the one used to create the challenge
    if (challenge.identityPublicKey !== dto.identityPublicKey) {
      throw new BadRequestException(
        'Identity key does not match the challenge',
      );
    }

    // 3. Decode values — nonce comes from the server's own stored copy
    const nonce = Buffer.from(challenge.nonce, 'base64');
    const signature = Buffer.from(dto.challengeSignature, 'base64');
    const publicKeyBytes = Buffer.from(dto.identityPublicKey, 'base64');

    // 4. Build the domain-separated message the client must have signed
    const messageToVerify = AuthHostService.buildChallengeMessage(
      expectedHost,
      nonce,
    );

    // 5. Deserialize Signal Protocol public key and verify signature
    try {
      const publicKey = PublicKey.deserialize(publicKeyBytes);
      const isValid = publicKey.verify(messageToVerify, signature);

      if (!isValid) {
        throw new UnauthorizedException('Invalid signature');
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new BadRequestException('Signature verification failed');
    }
  }

  /**
   * Save or update signed pre-key for user
   */
  private async saveSignedPreKey(
    userId: number,
    dto: IdentityAuthDto,
  ): Promise<void> {
    const deviceId = String(dto.deviceId);

    // Delete existing signed pre-key for this user/device
    await this.signalKeyRepository.delete({
      userId,
      deviceId,
      keyTypeId: KeyTypeId.SIGNED_PRE_KEY,
    });

    // Create new signed pre-key
    const signedPreKey = this.signalKeyRepository.create({
      userId,
      deviceId,
      keyTypeId: KeyTypeId.SIGNED_PRE_KEY,
      keyId: dto.signedPreKeyId,
      keyData: dto.signedPreKeyPublicKey,
      keySignature: dto.signedPreKeySignature,
      consumed: false,
    });

    await this.signalKeyRepository.save(signedPreKey);
  }

  /**
   * Generate JWT token for user.
   * `deviceId` is embedded so the server can forward it on sender-key
   * flows (H-04) without an extra DB lookup per relayed message.
   */
  generateToken(user: User, deviceId: number): string {
    const payload = {
      sub: user.id,
      deviceId,
    };

    return this.jwtService.sign(payload, {
      privateKey: this.jwtConfig.privateKey,
      algorithm: 'RS256',
      expiresIn: this.jwtConfig.expiresIn as any,
    });
  }

  /**
   * Refresh JWT token, preserving the deviceId of the calling session.
   */
  async refreshToken(
    userId: number,
    deviceId: number,
  ): Promise<{ accessToken: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (await this.banService.isUserBanned(userId)) {
      throw new UnauthorizedException('User is banned', 'BANNED');
    }

    const accessToken = this.generateToken(user, deviceId);

    return { accessToken };
  }

  /**
   * Validate JWT token
   */
  validateJWT(token: string): { sub: number; deviceId?: number } {
    try {
      return this.jwtService.verify(token, {
        publicKey: this.jwtConfig.publicKey,
        algorithms: ['RS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Register push notification token (Expo or Firebase)
   */
  async registerPushToken(
    userId: number,
    token: string,
    platform: string,
    provider?: PushProvider,
    lang?: string,
  ): Promise<void> {
    const existing = await this.pushTokenRepository.findOne({
      where: { token },
    });

    if (existing) {
      existing.userId = userId;
      existing.platform = platform as any;
      existing.provider = provider ?? PushProvider.EXPO;
      existing.lang = lang || 'en';
      await this.pushTokenRepository.save(existing);
    } else {
      const pushToken = this.pushTokenRepository.create({
        userId,
        token,
        platform: platform as any,
        provider: provider ?? PushProvider.EXPO,
        lang: lang || 'en',
      });
      await this.pushTokenRepository.save(pushToken);
    }
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: number): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}
