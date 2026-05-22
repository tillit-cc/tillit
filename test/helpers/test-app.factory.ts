import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import * as crypto from 'crypto';
import { io, Socket as ClientSocket } from 'socket.io-client';

// Entities
import { User } from '../../src/entities/user.entity';
import { Room } from '../../src/entities/room.entity';
import { RoomUser } from '../../src/entities/room-user.entity';
import { PushToken } from '../../src/entities/push-token.entity';
import { PendingMessage } from '../../src/entities/pending-message.entity';
import { SignalKey } from '../../src/entities/signal-key.entity';
import { SignalKeyType } from '../../src/entities/signal-key-type.entity';
import {
  UserDevice,
  UserDeviceStatus,
} from '../../src/entities/user-device.entity';
import { MediaBlob } from '../../src/entities/media-blob.entity';
import { MediaDownload } from '../../src/entities/media-download.entity';
import { SenderKeyDistribution } from '../../src/entities/sender-key-distribution.entity';
import { SenderKeyMetadata } from '../../src/entities/sender-key-metadata.entity';
import { DeviceLinkSession } from '../../src/entities/device-link-session.entity';

// Services & Modules
import { ChatGateway } from '../../src/modules/chat/gateways/chat.gateway';
import { MessageService } from '../../src/modules/chat/services/message.service';
import { RoomService } from '../../src/modules/chat/services/room.service';
import { ChatController } from '../../src/modules/chat/controllers/chat.controller';
import { AuthService } from '../../src/auth/auth.service';
import { ChallengeStore } from '../../src/auth/services/challenge.store';
import { AuthHostService } from '../../src/auth/services/auth-host.service';
import { JwtConfigService } from '../../src/config/jwt/config.service';
import { ExpoNotificationService } from '../../src/services/expo-notification.service';
import { PushRelayService } from '../../src/services/push-relay.service';
import { CloudWorkerConfigService } from '../../src/config/cloud-worker/config.service';
import { MediaConfigService } from '../../src/config/media/config.service';
import { SenderKeysService } from '../../src/modules/sender-keys/services/sender-keys.service';
import { RedisConfigService } from '../../src/config/database/redis/config.service';
import { AuthenticatedSocketAdapter } from '../../src/sockets/authenticated-socket.adapter';
import { BanService } from '../../src/modules/ban/ban.service';
import { DeviceLinkService } from '../../src/auth/services/device-link.service';
import { DeviceService } from '../../src/auth/services/device.service';
import { DataSource } from 'typeorm';

const ALL_ENTITIES = [
  User,
  Room,
  RoomUser,
  PushToken,
  PendingMessage,
  SignalKey,
  SignalKeyType,
  UserDevice,
  MediaBlob,
  MediaDownload,
  SenderKeyDistribution,
  SenderKeyMetadata,
  DeviceLinkSession,
];

/**
 * Generate RSA key pair for test JWT signing.
 */
function generateRSAKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export interface TestApp {
  app: INestApplication;
  module: TestingModule;
  jwtService: JwtService;
  authService: AuthService;
  dataSource: DataSource;
  url: string;
  close: () => Promise<void>;
  seedUser: (identityKey?: string) => Promise<User>;
  seedRoom: (
    creatorId: number,
    name?: string,
    options?: { useSenderKeys?: boolean },
  ) => Promise<Room>;
  addUserToRoom: (
    roomId: number,
    userId: number,
    username?: string,
  ) => Promise<void>;
  seedDevice: (
    userId: number,
    deviceId: number,
    status?: UserDeviceStatus,
  ) => Promise<UserDevice>;
  getToken: (userId: number, deviceId?: number) => string;
  createAuthenticatedClient: (token: string) => ClientSocket;
}

/**
 * Create a full test NestJS application with SQLite in-memory.
 */
export async function createTestApp(): Promise<TestApp> {
  const { publicKey, privateKey } = generateRSAKeyPair();

  const module: TestingModule = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ALL_ENTITIES,
        synchronize: true,
        dropSchema: true,
      }),
      TypeOrmModule.forFeature(ALL_ENTITIES),
      PassportModule,
      JwtModule.register({
        privateKey,
        publicKey,
        signOptions: { algorithm: 'RS256', expiresIn: '1h' },
      }),
    ],
    controllers: [ChatController],
    providers: [
      ChatGateway,
      MessageService,
      RoomService,
      AuthService,
      ChallengeStore,
      {
        provide: AuthHostService,
        useValue: {
          resolveExpectedHost: jest.fn().mockReturnValue('localhost'),
        },
      },
      SenderKeysService,
      ExpoNotificationService,
      {
        provide: JwtConfigService,
        useValue: {
          publicKey,
          privateKey,
          expiresIn: '1h',
          algorithm: 'RS256',
          publicKeyPath: '',
          privateKeyPath: '',
        },
      },
      {
        provide: CloudWorkerConfigService,
        useValue: {
          workerUrl: '',
          cloudId: '',
          cloudToken: '',
          ddnsEnabled: false,
          ddnsUpdateInterval: 300000,
          pushIncludeData: false,
        },
      },
      {
        provide: PushRelayService,
        useValue: {
          sendNotification: jest.fn(),
          isConfigured: jest.fn().mockReturnValue(false),
        },
      },
      {
        provide: MediaConfigService,
        useValue: { storageDir: '/tmp/tillit-test-media' },
      },
      {
        provide: RedisConfigService,
        useValue: undefined,
      },
      {
        provide: BanService,
        useValue: {
          isUserBanned: jest.fn().mockResolvedValue(false),
          banUser: jest.fn(),
          unbanUser: jest.fn().mockResolvedValue(true),
          listBannedUsers: jest.fn().mockResolvedValue([]),
        },
      },
      {
        // DeviceLinkService is built on top of the DB layer; the e2e tests
        // don't exercise pairing, so a thin stub is enough to satisfy the
        // gateway/JWT strategy hookups (revocation check returns false).
        provide: DeviceLinkService,
        useValue: {
          setNotifier: jest.fn(),
          isDeviceRevoked: jest.fn().mockResolvedValue(false),
          markDeviceActiveAfterKeyUpload: jest
            .fn()
            .mockResolvedValue(undefined),
        },
      },
      {
        provide: DeviceService,
        useValue: { setNotifier: jest.fn() },
      },
    ],
  }).compile();

  const app = module.createNestApplication();

  // Set up authenticated WebSocket adapter
  app.useWebSocketAdapter(new AuthenticatedSocketAdapter(app));

  await app.init();

  // Listen on random port
  await app.listen(0);
  const httpServer = app.getHttpServer();
  const address = httpServer.address();
  const port = typeof address === 'string' ? 0 : address.port;
  const url = `http://localhost:${port}`;

  const jwtService = module.get<JwtService>(JwtService);
  const authService = module.get<AuthService>(AuthService);
  const dataSource = module.get<DataSource>(DataSource);

  // Seed signal key types
  const sktRepo = dataSource.getRepository(SignalKeyType);
  await sktRepo.save([
    { id: 1, code: 'preKey', name: 'Pre Key' },
    { id: 2, code: 'kyberPreKey', name: 'Kyber Pre Key' },
    { id: 3, code: 'signedPreKey', name: 'Signed Pre Key' },
  ]);

  const getToken = (userId: number, deviceId = 1): string => {
    return jwtService.sign(
      { sub: userId, deviceId },
      { privateKey, algorithm: 'RS256' },
    );
  };

  const seedDevice = async (
    userId: number,
    deviceId: number,
    status: UserDeviceStatus = UserDeviceStatus.ACTIVE,
  ): Promise<UserDevice> => {
    const repo = dataSource.getRepository(UserDevice);
    const row = repo.create({
      userId,
      deviceId,
      registrationId: 1000 + deviceId,
      identityPublicKey: crypto.randomBytes(32).toString('base64'),
      status,
    });
    return repo.save(row);
  };

  const seedUser = async (identityKey?: string): Promise<User> => {
    const userRepo = dataSource.getRepository(User);
    const user = userRepo.create({
      identityPublicKey:
        identityKey || crypto.randomBytes(32).toString('base64'),
    });
    const saved = await userRepo.save(user);
    // Primary device is always present in real deployments — seed it so the
    // room-broadcast offline path (RoomService.getActiveDevices) sees the
    // single-device callers used by the older tests.
    await seedDevice(saved.id, 1);
    return saved;
  };

  const seedRoom = async (
    creatorId: number,
    name?: string,
    options?: { useSenderKeys?: boolean },
  ): Promise<Room> => {
    const roomRepo = dataSource.getRepository(Room);
    const room = roomRepo.create({
      inviteCode: crypto.randomBytes(4).toString('hex'),
      name: name || 'Test Room',
      status: 1, // ACTIVE
      idUser: creatorId,
      administered: false,
      useSenderKeys: options?.useSenderKeys ?? false,
    });
    return roomRepo.save(room);
  };

  const addUserToRoom = async (
    roomId: number,
    userId: number,
    username?: string,
  ): Promise<void> => {
    const ruRepo = dataSource.getRepository(RoomUser);
    await ruRepo.save(
      ruRepo.create({
        roomId,
        userId,
        username: username || `User-${userId}`,
        joinedAt: Date.now(),
      }),
    );
  };

  const createAuthenticatedClient = (token: string): ClientSocket => {
    return io(`${url}/chat`, {
      auth: { token: `Bearer ${token}` },
      transports: ['websocket'],
      forceNew: true,
    });
  };

  const close = async () => {
    await app.close();
  };

  return {
    app,
    module,
    jwtService,
    authService,
    dataSource,
    url,
    close,
    seedUser,
    seedRoom,
    addUserToRoom,
    seedDevice,
    getToken,
    createAuthenticatedClient,
  };
}
