import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { User } from '../entities/user.entity';
import { PushToken, PushProvider } from '../entities/push-token.entity';
import { SignalKey, KeyTypeId } from '../entities/signal-key.entity';
import { UserDevice, UserDeviceStatus } from '../entities/user-device.entity';
import { JwtConfigService } from '../config/jwt/config.service';
import { ChallengeStore } from './services/challenge.store';
import { AuthHostService } from './services/auth-host.service';
import { BanService } from '../modules/ban/ban.service';
import { IdentityAuthDto } from './dto/identity-auth.dto';
import {
  createMockRepository,
  makeUser,
  makePushToken,
  makeUserDevice,
} from '../test/helpers';

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
  let userDeviceRepo: ReturnType<typeof createMockRepository>;
  let jwtService: { sign: jest.Mock; verify: jest.Mock };
  let jwtConfig: { privateKey: string; publicKey: string; expiresIn: string };
  let challengeStore: {
    consumeChallenge: jest.Mock;
    createChallenge: jest.Mock;
  };
  let banService: { isUserBanned: jest.Mock };
  const TEST_HOST = 'api.tillit.cc';

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
    userDeviceRepo = createMockRepository();
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
        { provide: getRepositoryToken(UserDevice), useValue: userDeviceRepo },
        { provide: JwtService, useValue: jwtService },
        { provide: JwtConfigService, useValue: jwtConfig },
        { provide: ChallengeStore, useValue: challengeStore },
        {
          provide: AuthHostService,
          useValue: {
            resolveExpectedHost: jest.fn().mockReturnValue(TEST_HOST),
          },
        },
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

      const result = await service.authenticateByIdentity(makeDto(), TEST_HOST);

      expect(result.accessToken).toBe('jwt-token');
      expect(result.isNewUser).toBe(true);
      expect(userRepo.create).toHaveBeenCalled();
    });

    it('should return JWT for existing user', async () => {
      const existingUser = makeUser({ id: 1 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);

      const result = await service.authenticateByIdentity(makeDto(), TEST_HOST);

      expect(result.accessToken).toBe('jwt-token');
      expect(result.isNewUser).toBe(false);
      expect(result.userId).toBe(1);
    });

    // Multi-device pairing: the new device generates its own registrationId.
    // /auth/identity must accept a per-device value that differs from the
    // primary's. See _shared/tasks/backend-0007-per-device-registration-id.md.
    it('should accept a different registrationId for a linked device', async () => {
      const existingUser = makeUser({ id: 1 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);
      // backend-0014: linked device must have an active user_devices row.
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 2,
          status: UserDeviceStatus.ACTIVE,
        }),
      );

      const result = await service.authenticateByIdentity(
        makeDto({ deviceId: 2, registrationId: 99999 }),
        TEST_HOST,
      );

      expect(result.accessToken).toBe('jwt-token');
      expect(result.isNewUser).toBe(false);
      expect(result.userId).toBe(1);
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 1, deviceId: 2 },
        expect.any(Object),
      );
    });

    // backend-0014: pairing flow is allowed to authenticate while the row is
    // still in pending_link (between completeLink and POST /keys).
    it('should accept a linked device whose row is still pending_link', async () => {
      const existingUser = makeUser({ id: 1 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 3,
          status: UserDeviceStatus.PENDING_LINK,
        }),
      );

      const result = await service.authenticateByIdentity(
        makeDto({ deviceId: 3 }),
        TEST_HOST,
      );

      expect(result.accessToken).toBe('jwt-token');
    });

    // backend-0014: refuse a JWT mint for a non-existent linked device.
    it('should reject a non-primary deviceId with no user_devices row', async () => {
      const existingUser = makeUser({ id: 1 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);
      userDeviceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.authenticateByIdentity(makeDto({ deviceId: 7 }), TEST_HOST),
      ).rejects.toThrow(UnauthorizedException);
    });

    // backend-0014: refuse a JWT mint for a revoked device.
    it('should reject a non-primary deviceId whose row is revoked', async () => {
      const existingUser = makeUser({ id: 1 });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(existingUser);
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 4,
          status: UserDeviceStatus.REVOKED,
        }),
      );

      await expect(
        service.authenticateByIdentity(makeDto({ deviceId: 4 }), TEST_HOST),
      ).rejects.toThrow(UnauthorizedException);
    });

    // backend-0014: an account must be created from the primary device.
    it('should reject a new user with a non-primary deviceId', async () => {
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(null);

      await expect(
        service.authenticateByIdentity(makeDto({ deviceId: 2 }), TEST_HOST),
      ).rejects.toThrow(UnauthorizedException);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if challenge is invalid/expired', async () => {
      challengeStore.consumeChallenge.mockResolvedValue(null);

      await expect(
        service.authenticateByIdentity(makeDto(), TEST_HOST),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if identity key does not match challenge', async () => {
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'ZGlmZmVyZW50LWtleQ==', // different key
      });

      await expect(
        service.authenticateByIdentity(makeDto(), TEST_HOST),
      ).rejects.toThrow(BadRequestException);
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

      await expect(
        service.authenticateByIdentity(makeDto(), TEST_HOST),
      ).rejects.toThrow(UnauthorizedException);

      // Restore mock
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
    });

    it('should verify the domain-separated message, not the raw nonce', async () => {
      const { PublicKey } = require('@signalapp/libsignal-client');
      const verifyMock = jest.fn().mockReturnValue(true);
      PublicKey.deserialize.mockReturnValue({ verify: verifyMock });

      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=', // base64 of "nonce"
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(null);
      userRepo.save.mockImplementation((u: any) =>
        Promise.resolve({ ...u, id: 1 }),
      );

      await service.authenticateByIdentity(makeDto(), TEST_HOST);

      expect(verifyMock).toHaveBeenCalledTimes(1);
      const verifiedMessage: Buffer = verifyMock.mock.calls[0][0];
      const expectedPrefix = Buffer.from(
        `TilliT-Auth-Challenge-v1\n${TEST_HOST}\n`,
        'utf8',
      );
      const expectedMessage = Buffer.concat([
        expectedPrefix,
        Buffer.from('bm9uY2U=', 'base64'),
      ]);
      expect(verifiedMessage.equals(expectedMessage)).toBe(true);

      // Sanity: the raw nonce alone is NOT what we verified
      expect(verifiedMessage.equals(Buffer.from('bm9uY2U=', 'base64'))).toBe(
        false,
      );
    });
  });

  describe('authenticateByIdentity — per-device auth (ADR-0010)', () => {
    const { PublicKey } = require('@signalapp/libsignal-client');

    afterEach(() => {
      // Restore the default "verify → true" mock so other suites are unaffected.
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
    });

    it('requires and verifies the device-auth signature when one is registered', async () => {
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 1,
          authPublicKey: 'device-auth-pub',
        }),
      );

      const result = await service.authenticateByIdentity(
        makeDto({ deviceId: 1, deviceAuthSignature: 'valid-sig' }),
        TEST_HOST,
      );

      expect(result.accessToken).toBe('jwt-token');
    });

    it('blocks a linked device claiming deviceId=1 with an invalid device-auth signature (closes #4)', async () => {
      // Identity signature valid (shared key), but the device-auth signature
      // fails — a linked device cannot sign for device 1's auth key.
      PublicKey.deserialize
        .mockReturnValueOnce({ verify: jest.fn().mockReturnValue(true) })
        .mockReturnValueOnce({ verify: jest.fn().mockReturnValue(false) });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 1,
          authPublicKey: 'primary-auth-pub',
        }),
      );

      await expect(
        service.authenticateByIdentity(
          makeDto({ deviceId: 1, deviceAuthSignature: 'forged' }),
          TEST_HOST,
        ),
      ).rejects.toMatchObject({ response: { error: 'DEVICE_AUTH_INVALID' } });
    });

    it('rejects when the device-auth signature is missing for a bound device', async () => {
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({
          userId: 1,
          deviceId: 1,
          authPublicKey: 'primary-auth-pub',
        }),
      );

      await expect(
        service.authenticateByIdentity(makeDto({ deviceId: 1 }), TEST_HOST),
      ).rejects.toMatchObject({ response: { error: 'DEVICE_AUTH_INVALID' } });
    });

    it('rejects a device with no registered auth key when DEVICE_AUTH_REQUIRED=true', async () => {
      const prev = process.env.DEVICE_AUTH_REQUIRED;
      process.env.DEVICE_AUTH_REQUIRED = 'true';
      PublicKey.deserialize.mockReturnValue({
        verify: jest.fn().mockReturnValue(true),
      });
      challengeStore.consumeChallenge.mockResolvedValue({
        nonce: 'bm9uY2U=',
        identityPublicKey: 'dGVzdC1rZXk=',
      });
      userRepo.findOne.mockResolvedValue(makeUser({ id: 1 }));
      userDeviceRepo.findOne.mockResolvedValue(
        makeUserDevice({ userId: 1, deviceId: 1, authPublicKey: null }),
      );

      await expect(
        service.authenticateByIdentity(makeDto({ deviceId: 1 }), TEST_HOST),
      ).rejects.toMatchObject({ response: { error: 'DEVICE_AUTH_REQUIRED' } });

      if (prev === undefined) delete process.env.DEVICE_AUTH_REQUIRED;
      else process.env.DEVICE_AUTH_REQUIRED = prev;
    });
  });

  describe('generateToken', () => {
    it('should call jwtService.sign with sub + deviceId and RS256', () => {
      const user = makeUser({ id: 42 });
      service.generateToken(user, 3);

      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 42, deviceId: 3 },
        expect.objectContaining({
          algorithm: 'RS256',
          privateKey: 'private-key',
        }),
      );
    });
  });

  describe('refreshToken', () => {
    it('should return new token for existing user preserving deviceId', async () => {
      const user = makeUser({ id: 1 });
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.refreshToken(1, 5);

      expect(result.accessToken).toBe('jwt-token');
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 1, deviceId: 5 },
        expect.any(Object),
      );
    });

    it('should throw UnauthorizedException if user not found', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.refreshToken(999, 1)).rejects.toThrow(
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
