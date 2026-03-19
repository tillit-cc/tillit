import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { User } from '../entities/user.entity';
import { PushToken, PushProvider } from '../entities/push-token.entity';
import { SignalKey, KeyTypeId } from '../entities/signal-key.entity';
import { JwtConfigService } from '../config/jwt/config.service';
import { ChallengeStore } from './services/challenge.store';
import { BanService } from '../modules/ban/ban.service';
import { IdentityAuthDto } from './dto/identity-auth.dto';
import { createMockRepository, makeUser, makePushToken } from '../test/helpers';

// Mock libsignal-client
jest.mock('@signalapp/libsignal-client', () => ({
  PublicKey: {
    deserialize: jest.fn().mockReturnValue({
      verify: jest.fn().mockReturnValue(true),
    }),
  },
}));

describe('AuthService', () => {
  let service: AuthService;
  let userRepo: ReturnType<typeof createMockRepository>;
  let pushTokenRepo: ReturnType<typeof createMockRepository>;
  let signalKeyRepo: ReturnType<typeof createMockRepository>;
  let jwtService: { sign: jest.Mock; verify: jest.Mock };
  let jwtConfig: { privateKey: string; publicKey: string; expiresIn: string };
  let challengeStore: {
    consumeChallenge: jest.Mock;
    createChallenge: jest.Mock;
  };
  let banService: { isUserBanned: jest.Mock };

  const makeDto = (
    overrides: Partial<IdentityAuthDto> = {},
  ): IdentityAuthDto => ({
    identityPublicKey: 'dGVzdC1rZXk=',
    registrationId: 12345,
    deviceId: 1,
    signedPreKeyPublicKey: 'c2lnbmVkLWtleQ==',
    signedPreKeyId: 1,
    signedPreKeySignature: 'c2lnbmF0dXJl',
    challengeId: 'challenge-123',
    challengeSignature: 'c2lnbmF0dXJl',
    ...overrides,
  });

  beforeEach(async () => {
    userRepo = createMockRepository();
    pushTokenRepo = createMockRepository();
    signalKeyRepo = createMockRepository();
    jwtService = {
      sign: jest.fn().mockReturnValue('jwt-token'),
      verify: jest.fn().mockReturnValue({ sub: 1 }),
    };
    jwtConfig = {
      privateKey: 'private-key',
      publicKey: 'public-key',
      expiresIn: '7d',
    };
    challengeStore = {
      consumeChallenge: jest.fn(),
      createChallenge: jest.fn(),
    };
    banService = {
      isUserBanned: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(PushToken), useValue: pushTokenRepo },
        { provide: getRepositoryToken(SignalKey), useValue: signalKeyRepo },
        { provide: JwtService, useValue: jwtService },
        { provide: JwtConfigService, useValue: jwtConfig },
        { provide: ChallengeStore, useValue: challengeStore },
        { provide: BanService, useValue: banService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('authenticateByIdentity', () => {
    it('should create new user and return JWT', async () => {
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(null); // new user
      userRepo.save.mockImplementation((u: any) =>
        Promise.resolve({ ...u, id: 1 }),
      );

      const result = await service.authenticateByIdentity(makeDto());

      expect(result.accessToken).toBe('jwt-token');
      expect(result.isNewUser).toBe(true);
      expect(userRepo.create).toHaveBeenCalled();
    });

    it('should return JWT for existing user', async () => {
      const existingUser = makeUser({ id: 1, registrationId: 12345 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);

      const result = await service.authenticateByIdentity(makeDto());

      expect(result.accessToken).toBe('jwt-token');
      expect(result.isNewUser).toBe(false);
      expect(result.userId).toBe(1);
    });

    it('should throw ConflictException if registrationId mismatch', async () => {
      const existingUser = makeUser({ id: 1, registrationId: 99999 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);

      await expect(service.authenticateByIdentity(makeDto())).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequestException if challenge is invalid/expired', async () => {
      challengeStore.consumeChallenge.mockResolvedValue(null);

      await expect(service.authenticateByIdentity(makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if identity key does not match challenge', async () => {
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'ZGlmZmVyZW50LWtleQ==', // different key
      });

      await expect(service.authenticateByIdentity(makeDto())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when signature verification fails', async () => {
      const { PublicKey } = require('@signalapp/libsignal-client');
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(false),
      });

      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });

      await expect(service.authenticateByIdentity(makeDto())).rejects.toThrow(
        UnauthorizedException,
      );

      // Restore mock
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
    });
  });

  describe('generateToken', () => {
    it('should call jwtService.sign with sub: user.id and RS256', () => {
      const user = makeUser({ id: 42 });
      service.generateToken(user);

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 42 },
        expect.objectContaining({
          algorithm: 'RS256',
          privateKey: 'private-key',
        }),
      );
    });
  });

  describe('refreshToken', () => {
    it('should return new token for existing user', async () => {
      const user = makeUser({ id: 1 });
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.refreshToken(1);

      expect(result.accessToken).toBe('jwt-token');
    });

    it('should throw UnauthorizedException if user not found', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.refreshToken(999)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('validateJWT', () => {
    it('should return payload for valid token', () => {
      const result = service.validateJWT('valid-token');

      expect(result).toEqual({ sub: 1 });
      expect(jwtService.verify).toHaveBeenCalledWith(
        'valid-token',
        expect.objectContaining({
          publicKey: 'public-key',
          algorithms: ['RS256'],
        }),
      );
    });

    it('should throw UnauthorizedException for invalid token', () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      expect(() => service.validateJWT('bad-token')).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('registerPushToken', () => {
    it('should create new push token', async () => {
      pushTokenRepo.findOne.mockResolvedValue(null);

      await service.registerPushToken(1, 'token-123', 'ios');

      expect(pushTokenRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          token: 'token-123',
          provider: PushProvider.EXPO,
          lang: 'en',
        }),
      );
      expect(pushTokenRepo.save).toHaveBeenCalled();
    });

    it('should update existing push token', async () => {
      const existing = makePushToken({ id: 1, userId: 2, token: 'token-123' });
      pushTokenRepo.findOne.mockResolvedValue(existing);

      await service.registerPushToken(1, 'token-123', 'ios');

      expect(pushTokenRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1 }),
      );
      expect(pushTokenRepo.create).not.toHaveBeenCalled();
    });

    it('should default lang to en', async () => {
      pushTokenRepo.findOne.mockResolvedValue(null);

      await service.registerPushToken(1, 'token-123', 'ios');

      expect(pushTokenRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ lang: 'en' }),
      );
    });

    it('should use provided lang', async () => {
      pushTokenRepo.findOne.mockResolvedValue(null);

      await service.registerPushToken(
        1,
        'token-123',
        'ios',
        PushProvider.EXPO,
        'it',
      );

      expect(pushTokenRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ lang: 'it' }),
      );
    });
  });
});
