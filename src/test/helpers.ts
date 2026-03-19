import { Room, RoomStatus } from '../entities/room.entity';
import { RoomUser } from '../entities/room-user.entity';
import { User } from '../entities/user.entity';
import { PendingMessage } from '../entities/pending-message.entity';
import { SignalKey, KeyTypeId } from '../entities/signal-key.entity';
import { UserDevice } from '../entities/user-device.entity';
import {
  PushToken,
  Platform,
  PushProvider,
} from '../entities/push-token.entity';
import { MediaBlob } from '../entities/media-blob.entity';

/**
 * Create a mock TypeORM Repository with common methods stubbed.
 */
export function createMockRepository<T = any>() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    create: jest.fn().mockImplementation((dto) => ({ ...dto })),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      delete: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }),
  };
}

/**
 * Create a mock TypeORM DataSource with transaction support.
 */
export function createMockDataSource() {
  const mockManager = {
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  return {
    transaction: jest.fn().mockImplementation(async (cb: any) => {
      return cb(mockManager);
    }),
    manager: mockManager,
    _mockManager: mockManager,
  };
}

/**
 * Create a mock Socket.IO Server.
 */
export function createMockSocketServer() {
  const mockEmit = jest.fn();
  const mockExcept = jest.fn().mockReturnValue({ emit: mockEmit });

  const mockSocket = (userId?: number, socketId?: string) => ({
    id: socketId || 'socket-1',
    user: userId !== undefined ? { userId } : undefined,
    emit: jest
      .fn()
      .mockImplementation((_event: string, _data: any, ack?: Function) => {
        if (ack) ack(); // Auto-ack by default
      }),
    join: jest.fn(),
    leave: jest.fn(),
  });

  const defaultSockets: any[] = [];

  const server = {
    in: jest.fn().mockReturnValue({
      fetchSockets: jest.fn().mockResolvedValue(defaultSockets),
      emit: mockEmit,
      except: mockExcept,
    }),
    to: jest.fn().mockReturnValue({
      emit: mockEmit,
      except: mockExcept,
    }),
    emit: mockEmit,
    _mockEmit: mockEmit,
    _mockSocket: mockSocket,
    _setSockets: (sockets: any[]) => {
      const fetchSockets = jest.fn().mockResolvedValue(sockets);
      server.in = jest.fn().mockReturnValue({
        fetchSockets,
        emit: mockEmit,
        except: mockExcept,
      });
    },
  };

  return server;
}

/**
 * Factory: create a User entity with defaults.
 */
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    identityPublicKey: 'dGVzdC1rZXk=',
    registrationId: 12345,
    createdAt: new Date(),
    updatedAt: new Date(),
    roomMemberships: [],
    pushTokens: [],
    signalKeys: [],
    ...overrides,
  } as User;
}

/**
 * Factory: create a Room entity with defaults.
 */
export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 1,
    inviteCode: 'abc12345',
    name: 'Test Room',
    status: RoomStatus.ACTIVE,
    idUser: 1,
    useSenderKeys: false,
    administered: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    roomUsers: [],
    ...overrides,
  } as Room;
}

/**
 * Factory: create a RoomUser entity with defaults.
 */
export function makeRoomUser(overrides: Partial<RoomUser> = {}): RoomUser {
  return {
    id: 1,
    roomId: 1,
    userId: 1,
    username: 'TestUser',
    joinedAt: Date.now(),
    room: undefined as any,
    user: undefined as any,
    ...overrides,
  } as RoomUser;
}

/**
 * Factory: create a PendingMessage entity with defaults.
 */
export function makePendingMessage(
  overrides: Partial<PendingMessage> = {},
): PendingMessage {
  return {
    id: 'msg-uuid-1',
    userId: 1,
    roomId: 1,
    envelope: JSON.stringify({
      id: 'msg-uuid-1',
      roomId: 1,
      senderId: 2,
      message: 'hello',
    }),
    createdAt: Date.now(),
    expiresAt: Date.now() + 604800000,
    attempts: 0,
    ...overrides,
  } as PendingMessage;
}

/**
 * Factory: create a SignalKey entity with defaults.
 */
export function makeSignalKey(overrides: Partial<SignalKey> = {}): SignalKey {
  return {
    id: 1,
    userId: 1,
    deviceId: '1',
    keyTypeId: KeyTypeId.PRE_KEY,
    keyId: 100,
    keyData: 'base64keydata',
    keySignature: null,
    consumed: false,
    createdAt: new Date(),
    ...overrides,
  } as SignalKey;
}

/**
 * Factory: create a UserDevice entity with defaults.
 */
export function makeUserDevice(
  overrides: Partial<UserDevice> = {},
): UserDevice {
  return {
    id: 1,
    userId: 1,
    deviceId: 1,
    registrationId: 12345,
    identityPublicKey: 'base64identitykey',
    lastActiveAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as UserDevice;
}

/**
 * Factory: create a PushToken entity with defaults.
 */
export function makePushToken(overrides: Partial<PushToken> = {}): PushToken {
  return {
    id: 1,
    userId: 1,
    token: 'ExponentPushToken[xxx]',
    platform: Platform.IOS,
    provider: PushProvider.EXPO,
    lang: 'en',
    createdAt: new Date(),
    ...overrides,
  } as PushToken;
}

/**
 * Factory: create a MediaBlob entity with defaults.
 */
export function makeMediaBlob(overrides: Partial<MediaBlob> = {}): MediaBlob {
  return {
    id: 'media-uuid-1',
    roomId: 1,
    uploaderId: 1,
    filePath: 'room-1/file.enc',
    mimeType: 'application/octet-stream',
    size: 1024,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    ephemeral: false,
    maxDownloads: null,
    downloadCount: 0,
    ...overrides,
  } as MediaBlob;
}

/**
 * Create a mock Socket client for gateway tests.
 */
export function makeMockClient(userId?: number, socketId?: string) {
  return {
    id: socketId || `socket-${userId || 'anon'}`,
    user: userId !== undefined ? { userId } : undefined,
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
  };
}
