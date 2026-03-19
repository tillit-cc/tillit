# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TilliT is an end-to-end encrypted chat application designed for **privacy-first, self-hosted deployments**.

### Architecture
1. **Backend (tillit)**: Lightweight NestJS server designed to run on dedicated hardware
2. **Mobile App (tillit-native)**: Expo (react-native) application with Signal Protocol encryption

### Product Vision

**Self-Hosted Privacy Server**: Each customer gets their own physical hardware device with TilliT backend pre-installed:
- **Plug-and-Play**: Hardware includes integrated DDNS for automatic domain configuration
- **Zero-Knowledge**: Backend only relays encrypted data, never accesses plaintext
- **Multi-Server Support**: Mobile app can connect to multiple independent servers
- **Complete Anonymity**: No central authority, each customer controls their data
- **Lightweight**: Optimized to run on low-power ARM devices (Raspberry Pi class)

**Target Deployment**:
- Single-board computer (Raspberry Pi 4, Orange Pi, etc.)
- 2-4GB RAM
- 32GB+ SD card
- Automatic DDNS setup (Cloudflare Worker relay)
- Pre-configured systemd services

The system implements the Signal Protocol for end-to-end encryption, where all messages are encrypted client-side and the server only relays encrypted data without access to plaintext content.

### Key Concepts

- **Room-based Chat**: Users create rooms with invite codes. Room creators share invite codes with other users to join.
- **Administered Rooms**: Rooms have an `administered` flag (default `false`). Non-administered rooms can be deleted by any member. Administered rooms can only be deleted by the admin (creator, `idUser`); non-admin members can only leave, which broadcasts `userLeftRoom` so other clients clean up that user's messages locally.
- **Signal Protocol**: Implements Double Ratchet algorithm with X3DH key agreement for forward secrecy and post-quantum security (Kyber keys).
- **Message Categories**: Messages are categorized as 'user' (encrypted user messages), 'control' (encrypted/unencrypted control packets), 'system' (server notifications), or 'action' (message actions like edit/delete).
- **Session Establishment**: Bidirectional handshake where joining user initiates session creation and room creator confirms.

## Commands

### Development
- `pnpm run start:dev` - Start development server with hot reload
- `pnpm run start:debug` - Start server in debug mode with watch
- `pnpm run build` - Build the project
- `pnpm run start:prod` - Run production build from dist/

### Testing
- `pnpm run test` - Run unit tests (116 tests across 9 suites)
- `pnpm run test:watch` - Run tests in watch mode
- `pnpm run test:cov` - Run tests with coverage report
- `pnpm run test:e2e` - Run end-to-end tests (12 tests including WebSocket integration)
- `pnpm run test:debug` - Run tests in debug mode

**Test structure**:
- `src/**/*.spec.ts` — Unit tests (mock-based, fast). Shared helpers in `src/test/helpers.ts`
- `test/chat-websocket.e2e-spec.ts` — WebSocket integration tests with SQLite in-memory + real Socket.IO
- `test/helpers/test-app.factory.ts` — E2E test app factory (RSA key generation, user/room seeding, authenticated socket client)

**Jest config notes**:
- `transformIgnorePatterns` in `package.json` and `test/jest-e2e.json` handle ESM packages (uuid, socket.io) under pnpm's `.pnpm/` layout
- `@signalapp/libsignal-client` is mocked in E2E tests via `moduleNameMapper` (native ESM addon)
- E2E uses `test/setup-e2e.ts` to set `DEPLOYMENT_MODE=selfhosted` before entity imports (SQLite compat)

### Code Quality
- `pnpm run lint` - Run ESLint with auto-fix
- `pnpm run format` - Format code with Prettier

## Architecture

### Core Components

**WebSocket Gateway Pattern**: The application uses NestJS WebSocket gateways (`@WebSocketGateway` decorator) to handle real-time events. Gateways implement lifecycle hooks (`OnGatewayInit`, `OnGatewayConnection`, `OnGatewayDisconnect`) and use `@SubscribeMessage` decorators for event handlers.

**Custom WebSocket Adapter**: `src/sockets/authenticated-socket.adapter.ts` extends `IoAdapter` to provide custom Socket.IO middleware. It validates Bearer tokens on connection via the `createIOServer` method.

**Room-based Broadcasting**: The application uses Socket.IO rooms for targeted message delivery. Clients can join/leave rooms dynamically, and the server broadcasts events to specific rooms.

### Configuration Pattern

The application uses NestJS `@nestjs/config` with domain-specific configuration modules organized in `src/config/`. Each config domain (e.g., app, database, feature-specific) follows a consistent pattern:
- `configuration.ts` - Registers config namespace with `registerAs()`
- `config.service.ts` - Provides typed access to config values
- `config.module.ts` - NestJS module setup with `ConfigModule.forFeature()`

Environment variables are loaded from `.env` file (see `.env.sample` for template).

### Module Structure

```
AppModule (src/app.module.ts)
├── AppConfigModule - Application-level configuration
├── DatabaseModule - MariaDB or SQLite (based on DEPLOYMENT_MODE)
├── AuthModule - Authentication with Passport
├── ChatModule - WebSocket functionality + chat logic
├── KeysModule - Signal Protocol key management
├── SenderKeysModule - Sender key distribution
├── BanModule (global) - User ban enforcement (cache + DB)
├── ModerationModule - DSA reporting (POST /moderation/report)
└── DdnsModule - Dynamic DNS updates (opt-in via DDNS_ENABLED)
    ├── CloudWorkerConfigModule - Cloud worker configuration (CLOUD_WORKER_URL, CLOUD_ID, CLOUD_TOKEN)
    └── DdnsService - IP detection + Worker API calls
```

### Directory Structure

**Backend (tillit)**:
- `src/common/types/` - Shared TypeScript types (`AuthenticatedRequest`, `AuthenticatedSocket`)
- `src/config/` - Configuration modules organized by domain (app, cloud-worker)
- `src/database/` - Database adapters and connections (SQLite for self-hosted, MariaDB for cloud)
- `src/modules/chat/` - Chat module with controllers, gateways, services
- `src/auth/` - Authentication logic and guards
- `src/services/` - Business logic services (e.g., push notifications, push relay)
- `src/interfaces/` - TypeScript interfaces for data models and events
- `src/entities/` - TypeORM entities for MariaDB tables
- `src/utils/` - Utility functions

## Key Files

### Backend (tillit)

- `src/main.ts` - Application bootstrap, configures custom WebSocket adapter
- `src/app.module.ts` - Root module with all imports
- `src/sockets/authenticated-socket.adapter.ts` - Custom Socket.IO adapter with authentication middleware
- `src/modules/chat/controllers/chat.controller.ts` - REST API endpoints for room management
- `src/modules/chat/gateways/chat.gateway.ts` - WebSocket gateway for real-time messaging
- `src/modules/chat/services/room.service.ts` - Room business logic (createRoom, deleteRoom, leaveRoom)
- `src/entities/*.entity.ts` - TypeORM entities for database tables
- `.env.sample` - Environment variables template

## Signal Protocol Implementation

> **Full documentation**: [`docs/signal-protocol.md`](docs/signal-protocol.md) — comprehensive security architecture document for security reviewers.

The backend is a **zero-knowledge relay**: it stores only public keys, relays opaque encrypted envelopes, and cannot decrypt any content. Key aspects:

- **Authentication**: Passwordless challenge-response with Ed25519 identity key signature (no phone/email/password)
- **Key storage**: Only public keys (pre-keys, signed pre-keys, Kyber post-quantum keys) per `(userId, deviceId)`
- **Session establishment**: X3DH key agreement on client; server provides key bundles and relays `SESSION_ESTABLISHED` packets
- **Message relay**: Server validates structure and room membership, never inspects encrypted content (max 64KB WebSocket payload)
- **Sender keys**: Group optimization where sender keys are encrypted per-recipient with pair-wise Signal sessions
- **Offline queue**: Encrypted envelopes stored in `pending_messages` (7-day TTL), delivered on reconnect with ack-based deletion
- **Media**: Client-encrypted `.enc` blobs stored on filesystem; ephemeral media with TTL and per-user download tracking
- **Push**: Generic "New message" by default (no content), optional metadata with `PUSH_INCLUDE_DATA=true`

### Database Entities

**User** (`user.entity.ts`): `id`, `identityPublicKey` (unique, base64), `registrationId`
**Room** (`room.entity.ts`): `id`, `inviteCode`, `name`, `status` (CREATED/ACTIVE/ARCHIVED/DELETED), `idUser`, `useSenderKeys`, `administered`
**RoomUser** (`room-user.entity.ts`): `roomId`, `userId`, `username`, `joinedAt`
**UserDevice** (`user-device.entity.ts`): `userId` + `deviceId` (unique pair), `registrationId`, `identityPublicKey`
**SignalKey** (`signal-key.entity.ts`): pre-keys (type 1), Kyber pre-keys (type 2), signed pre-keys (type 3) — all CASCADE on user delete
**PendingMessage** (`pending-message.entity.ts`): `userId`, `roomId`, `envelope` (encrypted JSON), `expiresAt`
**MediaBlob** (`media-blob.entity.ts`): `roomId`, `uploaderId`, `filePath`, `ephemeral`, `maxDownloads`, `downloadCount`
**Report** (`report.entity.ts`): `reporterUserId`, `reportedUserId`, `roomId`, `messageId?`, `reason`, `description?`, `status` (pending/reviewed/dismissed/actioned), `createdAt`
**BannedUser** (`banned-user.entity.ts`): `userId` (unique), `reason?`, `bannedAt` — CASCADE on user delete

## API Reference

### REST Endpoints (Backend)

All endpoints require JWT authentication via `Authorization: Bearer <token>` header.

**Room Management** (`/chat`):
- `PUT /chat` - Create new room (body: `{ name?, username?, administered? }`), returns invite code
- `POST /chat/:code` - Join room using invite code
- `GET /chat/:id/members` - Get room members (excludes current user)
- `DELETE /chat/:id` - Delete or leave room. Behavior depends on room type:
  - Non-administered room: any member deletes the room, broadcasts `roomDeleted`
  - Administered room + admin: deletes the room, broadcasts `roomDeleted`
  - Administered room + non-admin: leaves the room, broadcasts `userLeftRoom`, returns `{ action: 'left' }`
- `GET /chat` - Get all rooms for current user (includes `administered` field)

**Authentication** (`/auth`):
- `POST /auth/challenge` - Request challenge nonce (body: `{ identityPublicKey }`)
- `POST /auth/identity` - Authenticate with signed challenge (body: `{ identityPublicKey, challengeId, challengeSignature, registrationId, deviceId, signedPreKey... }`)
- `GET /auth/status` - Server reachability + ban check (JwtAuthGuard). Returns `{ status: 'ok' }` on success, or 401 with `error: 'BANNED'` if banned (standard 401 if token invalid/missing). If server is unreachable, client handles as offline.
- `POST /auth/refresh` - Refresh JWT token

**Signal Keys** (`/signal-keys`):
- `POST /signal-keys/upload` - Upload pre-keys and identity key for device
- `GET /signal-keys/bundle/:userId/:deviceId` - Get key bundle for establishing session

**Moderation** (`/moderation`):
- `POST /moderation/report` - Report a user or message (body: `{ reportedUserId, roomId, messageId?, reason, description? }`). Reasons: `spam`, `harassment`, `illegal_content`, `other`. Reporter must be room member.

### Ban Enforcement

Banned users are blocked at 3 levels: JWT strategy (all REST), auth service (login/refresh), WebSocket adapter (socket connections). `BanModule` is global with in-memory cache. CLI commands: `tillit moderation ban/unban/banned`. REST ban responses return 401 with `error: 'BANNED'`; WebSocket ban returns `Error.message === 'BANNED'`.

### WebSocket Events

**Client → Server**:
- `sendMessage` - Send user message envelope
- `sendPacket` - Send control packet envelope
- `joinRoom` - Join a room's WebSocket channel
- `leaveRoom` - Leave a room's WebSocket channel

**Server → Client**:
- `newMessage` - Receive message envelope
- `newPacket` - Receive control packet
- `userJoined` - User joined room (transient, Socket.IO join)
- `userLeft` - User left room (transient, Socket.IO leave)
- `userOnline` - User came online (sender key rooms only)
- `roomDeleted` - Room was permanently deleted `{ roomId, deletedBy, timestamp }`
- `userLeftRoom` - User permanently left an administered room `{ roomId, userId, timestamp }` — other clients should delete that user's messages locally

### Message Flow (Backend Side)

**Sending**: Client emits `sendMessage` → backend validates room membership → generates UUID + timestamp → relays to room via `deliverToRoomWithAck()` → non-acking sockets get messages queued in `pending_messages`

**Control packets**: Client emits `sendPacket` → backend relays via `sendControlPacket()` → can target specific `recipientIds` → volatile packets skip offline queue

**Reconnect**: On WebSocket connect → auto-joins all user's rooms → replays pending messages per room → deletes from DB only after client ack

## Important Notes

- **Deployment Modes**: `DEPLOYMENT_MODE=selfhosted` uses SQLite (no external dependencies), `DEPLOYMENT_MODE=cloud` uses MariaDB + Redis
- **WebSocket Authentication**: Implemented in `authenticated-socket.adapter.ts` with Bearer token validation
- **Environment Variables**: Copy `.env.selfhosted.sample` or `.env.cloud.sample` to `.env` and configure before running
- **Package Manager**: This project uses `pnpm` instead of npm

### Configurable Constants (Environment Variables)

All operational constants are configurable via environment variables with sensible defaults. Pattern: `parseInt(process.env.VAR || 'default', 10)`.

| Variable | Default | Description |
|---|---|---|
| `PENDING_MESSAGE_TTL_MS` | 604800000 (7d) | Pending message retention in ms |
| `CHALLENGE_TTL_SECONDS` | 60 | Auth challenge TTL in seconds |
| `CHALLENGE_CLEANUP_INTERVAL_MS` | 30000 | Challenge cleanup interval (in-memory mode) |
| `THROTTLE_TTL_MS` | 60000 | Global rate limit window in ms |
| `THROTTLE_GLOBAL_LIMIT` | 60 | Global rate limit (requests per window) |
| `THROTTLE_AUTH_LIMIT` | 5 | Auth endpoint rate limit |
| `THROTTLE_MEDIA_LIMIT` | 10 | Media upload rate limit |
| `THROTTLE_KEYS_LIMIT` | 20 | Signal keys endpoint rate limit |
| `EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS` | 24 | Default ephemeral media TTL in hours |
| `EPHEMERAL_MEDIA_MAX_TTL_HOURS` | 168 (7d) | Max ephemeral media TTL in hours |
| `INVITE_CODE_LENGTH` | 8 | Room invite code length in characters |
| `MAX_VOLATILE_PAYLOAD_BYTES` | 10485760 (10MB) | Max volatile message payload size |
| `PUSH_NOTIFICATION_SOUND` | default | Push notification sound file |
| `THROTTLE_KEY_FETCH_PER_TARGET` | 3 | Key fetch rate limit per (requester, target) pair |

## Best Practices

1. **Never modify sendPacket() directly**: Use `MessageEnvelopeFactory` methods to create properly formatted envelopes with correct `encrypted` flags.

2. **Session establishment**: Always ensure both sides join the WebSocket room before attempting to send messages.

3. **Cascade deletes**: All foreign keys to User should have `onDelete: 'CASCADE'` to prevent orphaned records.

4. **Self-session protection**: Always check if `remoteUserId === ownUserId` before attempting Signal Protocol operations to prevent errors.

5. **Encryption flags**: Trust `envelope.encrypted` flag - don't make assumptions about which message types are encrypted. The factory handles this logic.

## Dual-Mode Architecture

The application supports two deployment modes controlled by `DEPLOYMENT_MODE` environment variable:

| Mode | Database | Redis | Socket.IO | Target |
|------|----------|-------|-----------|--------|
| `selfhosted` | SQLite | No | Single-instance | Raspberry Pi, single-board computers |
| `cloud` | MariaDB | Yes (pub/sub + challenge store) | Multi-instance | Cloud/VPS |

**Key files**:
- `src/config/deployment-mode.ts` — Enum, `isCloudMode()` / `isSelfhostedMode()` helpers
- `src/database/adapters/` — Database adapter factory pattern (MariaDB vs SQLite)
- `src/database/migrations/mariadb/` and `src/database/migrations/sqlite/` — Separate migrations per DB

**Offline message queue**: Messages for offline users are stored in `pending_messages` table (7-day TTL) and delivered automatically on reconnect via `ChatGateway.handleConnection`.

## Self-Hosted Deployment

See [README.md](README.md) for full installation guides (Docker, bare-metal, HTTPS, Cloudflare Tunnel).
See [`docs/self-hosted-dns.md`](docs/self-hosted-dns.md) for DNS alternatives (own DNS, reverse proxy, Tailscale, Cloudflare Tunnel, self-hosted cloud worker).

**Key scripts**: `scripts/install.sh` (Docker), `scripts/install-bare.sh` (bare-metal), `scripts/tillit-cli.sh` (CLI management tool), `scripts/rpi-setup.sh` (zero-terminal RPi SD card setup), `scripts/tillit-firstboot.sh` (RPi first-boot auto-installer)

**Zero-terminal RPi setup**: See [`docs/raspberry-pi-setup.md`](docs/raspberry-pi-setup.md) — flash SD with Imager, run `rpi-setup.sh` on PC, boot Pi, TilliT installs automatically.

**Key files**:

| File | Description |
|------|-------------|
| `docker-compose.selfhosted.yml` | HTTP-only mode |
| `docker-compose.https.yml` | Caddy reverse proxy with Let's Encrypt (DNS-01 via ACME-DNS) |
| `docker-compose.tunnel.yml` | Cloudflare Tunnel sidecar |
| `docker-compose.tor.yml` | Tor Hidden Service sidecar (.onion access) |
| `Caddyfile` / `Dockerfile.caddy` | Custom Caddy with acmedns module |
| `scripts/reset-instance.sh` | Reset server to clean state (new keys, empty DB) |

## Cloud Worker Integration

The backend integrates with the TilliT cloud worker (separate, optional service) for two features:

- **DDNS**: `DdnsModule` (`src/modules/ddns/`) sends periodic IP updates via `POST /update` to register `{boxId}.tillit.cc`
- **Push relay**: `PushRelayService` (`src/services/push-relay.service.ts`) relays push notifications via `POST /push` so self-hosted boxes don't need `EXPO_ACCESS_TOKEN`

**Configuration** (`src/config/cloud-worker/`):
```
CLOUD_WORKER_URL=https://worker.tillit.cc
CLOUD_ID=your-box-id
CLOUD_TOKEN=your-box-token
DDNS_ENABLED=false
DDNS_UPDATE_INTERVAL=300000
PUSH_INCLUDE_DATA=false
```

**Push notification modes** in `MessageService.sendPushNotificationsToUsers()`:
- Cloud mode → direct Expo SDK
- Self-hosted + cloud worker → `PushRelayService` (with i18n `lang`)
- Self-hosted without cloud worker → direct Expo SDK fallback (requires `EXPO_ACCESS_TOKEN`)

## Debugging

### Logging

Backend uses NestJS Logger. Enable debug logs: `LOG_LEVEL=debug` in `.env`.

### Common Issues

**Messages not relayed**: Check WebSocket connection, room membership in DB, and backend logs for relay errors.

**Key bundle fetch fails**: Verify user has uploaded keys (`signal_keys` table), check `consumed` status on pre-keys.

**Pending messages not delivered**: Check `pending_messages` table, verify `expiresAt` hasn't passed, confirm client acks on reconnect.
