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

### Multi-device pairing (wire v2.1)

A single identity (per-user `identityPublicKey`) can be shared across up to 5 active devices. Wire contract: `_shared/api/multi-device-linking.md`. ADRs: `_shared/decisions/0001-multi-device-architecture.md`, `_shared/decisions/0003-pairing-direction-flip.md`, `_shared/decisions/0004-symmetric-safety-number.md`.

Backend role is intentionally minimal — all cryptography (X25519 ECDHE → HKDF → AES-256-GCM, safety number verification) runs on-device. Direction is **new-device-shows-QR / primary-scans** (Signal Desktop / WhatsApp Web pattern). The v2.1 wire adds an intermediate `/share-pubkey` round-trip so the safety number is computed and verified **on both sides before** the encrypted payload is committed (ADR-0004).

Flow:
1. **New device** generates an X25519 ephemeral keypair and calls `POST /auth/devices/link/init` (anonymous) with the public key + optional UA metadata. Server returns `{ sessionId, expiresAt }`.
2. **New device** renders a QR (`tillit://link?v=2&i=<sessionId>&s=<base64url(server_origin)>&e=<base64url(E_pub)>`). `E_pub` travels in-band — the server never relays it to the primary.
3. **Primary** scans the QR, verifies `serverOrigin` matches its own server, generates its own ephemeral `P_pub`.
4. **Primary** publishes `P_pub` via `POST /auth/devices/link/share-pubkey` (primary JWT). The server attaches `primary_user_id/primary_device_id` from the JWT, saves `P_pub`, and flips `device_link_sessions.status` from `waiting` to `pubkey-shared`. No device row is created yet, no `assignedDeviceId` emitted.
5. **New device** polls `GET /auth/devices/link/session/:sessionId/result` and now receives `{ status: 'pubkey-shared', primaryEphemeralPublicKey, primaryUserId, identityKeyPub }` (the server looks up `identityKeyPub` from the primary's `users.identity_public_key`). Both sides compute and compare the safety number out-of-band.
6. On Match, **primary** encrypts the identity payload with `HKDF(X25519(P_priv, E_pub))` and uploads it via `POST /auth/devices/link/complete` with `{ sessionId, encryptedPayload }` (no `primaryEphemeralPublicKey` — already known). Server requires `status='pubkey-shared'`, assigns a monotonic `deviceId` (no reuse after revoke), creates a `user_devices` row with `status='pending_link'`, and flips `status='completed'`.
7. **New device** polls the result, receives `{ status: 'completed', encryptedPayload, primaryEphemeralPublicKey, primaryUserId, identityKeyPub, assignedDeviceId }`. One-time-use: subsequent polls return `410 SESSION_ALREADY_CONSUMED`.
8. **New device** decrypts, validates `identityPub` from the plaintext against the `identityKeyPub` it already received at step 5 (anti-server-tamper), imports the identity into Keychain, generates its own fresh pre-keys/signed pre-key/kyber pre-keys, and calls `POST /keys`. The server flips `user_devices.status` to `active` and emits `deviceLinked` to the primary.

Cap & flood control: `MULTI_DEVICE_CAP` (default 5) hard-limits active+pending_link devices per user; `MULTI_DEVICE_OPEN_TOKEN_CAP` (default 1000 in v2) is the **global soft cap** on open `waiting` sessions — protects the anonymous `/link/init` endpoint from flooding, paired with per-IP rate limiting at the controller. `DEVICE_LINK_TTL_MS` (default 300000) sets the per-step window; the result window is refreshed at `complete` time so the new device gets another full TTL to poll. A background sweeper soft-expires lapsed sessions every `DEVICE_LINK_CLEANUP_INTERVAL_MS` (default 60s) and hard-deletes them 1h later.

Revocation:
- `DELETE /auth/devices/:id` (primary-only) flips a linked device to `status='revoked'`, deletes its pre-keys, emits `deviceRevoked { self:true, ... }` to its sockets, then `deviceRevoked { self:false, ... }` to every peer sharing a room, and finally force-disconnects the device's sockets.
- `DELETE /auth/devices/me` is the linked device's self-logout (identical effect on its row). Primary self-logout goes through `DELETE /auth/account`.
- Subsequent authenticated requests from a revoked device's JWT return `401 DEVICE_REVOKED` (JwtStrategy + AuthenticatedSocketAdapter both enforce this).

`GET /keys/:userId` now returns `{ devices: [...] }` — one bundle per active device. Top-level `signedPreKey`/`preKey`/`kyberPreKey` mirror `devices[0]` so v0.x single-device clients still work during rollout.

`sendMessage` now accepts a `recipients: Array<{ userId, deviceId, ciphertext }>` field for multi-device fan-out — the gateway picks the right socket per `(userId, deviceId)`. Offline devices get their per-device ciphertext queued individually in `pending_messages`. The legacy single-`message` path is unchanged.

### Per-device server-auth credential (ADR-0010)

Server-side authentication is **decoupled from the E2E identity**. Because the identity key is shared across all of a user's devices (multi-device pairing), identity-only login let any linked device claim `deviceId: 1` and act as primary (finding #4). The fix: each device binds its own **device-auth keypair** (Curve25519/XEdDSA) to `(userId, deviceId)`, verified independently of the E2E identity. **No E2E impact** — all key agreement and message crypto are unchanged. ADR: `_shared/decisions/0010-per-device-server-auth-credential.md`; wire: `_shared/api/per-device-server-auth.md`.

- **TOFU binding**: the device uploads `deviceAuthPublicKey` on `POST /keys`. First upload binds it (`UserDevice.authPublicKey`, nullable); re-uploading the same key is a no-op; a different key returns `409 DEVICE_AUTH_MISMATCH` (unless `recoverPrimary`).
- **Login verification**: once bound, `POST /auth/identity` requires a valid `deviceAuthSignature` (XEdDSA over the same domain-separated challenge message as the identity signature). The old `deviceId===1` exemption in that branch is removed.
- **Transition mode**: rows without a bound auth key still authenticate identity-only, so existing installs keep working. `DEVICE_AUTH_REQUIRED` (default `false`) flips to mandatory — unbound rows then get `401 DEVICE_AUTH_REQUIRED` (rollout flip tracked as ADR-0010 OQ-5).
- **No primary recovery (ADR-0011)**: there is **no server-side recovery** of a lost primary device-auth key. `POST /keys` never silently re-binds a different key (`409 DEVICE_AUTH_MISMATCH`, no override). Rationale: recovery would be authorized by the shared identity key alone → any linked device could re-claim `deviceId=1` and reopen finding #4. Coherent with the no-backup ethos: **losing the primary = recreate the account**. This closes finding #4 *absolutely* (not just at steady state).
- **Liveness lock (ADR-0011)**: the primary is the account's liveness anchor. Its `lastActiveAt` (row `deviceId=1`) is refreshed on the primary's login/refresh/WebSocket connect **and on in-progress authenticated socket activity** (any `sendMessage`/`sendPacket`/`joinRoom`/`leaveRoom`/`requestSenderKeys`, write throttled 1h) — the level-triggered bump (backend-0022) so a primary holding a persistent socket stays alive without reconnecting. When a linked device (`deviceId !== 1`) logs in / refreshes / connects, the server checks the primary's idle time — if it exceeds `PRIMARY_LIVENESS_MAX_IDLE_MS` (default 7d) the linked device is refused (`401 PRIMARY_INACTIVE` over REST; `Error.message === 'PRIMARY_INACTIVE'` over WebSocket). **Enforcement is also level-triggered (backend-0022)**: a periodic gateway sweep (`PRIMARY_LIVENESS_SWEEP_MS`, default 10min) force-disconnects already-connected linked sockets whose primary has gone stale — catching a stolen device that only *receives* and never re-hits a gate. Each instance sweeps only its own local sockets (no cross-pod coordination on EKS). The real abuse window is `PRIMARY_LIVENESS_MAX_IDLE_MS + PRIMARY_LIVENESS_SWEEP_MS`. **Soft + reversible**: the linked device is not revoked; the primary coming back online unlocks it with no re-pairing. A primary row with no `lastActiveAt` yet (pre-rollout) is treated as fresh (grace). Bounds the window a stolen/rogue linked device can operate without the legitimate primary present. ADR: `_shared/decisions/0011-no-primary-recovery-and-liveness-lock.md`.

### Database Entities

**User** (`user.entity.ts`): `id`, `identityPublicKey` (unique, base64). `registrationId` is per-device — see `UserDevice`.
**Room** (`room.entity.ts`): `id`, `inviteCode`, `name`, `status` (CREATED/ACTIVE/ARCHIVED/DELETED), `idUser`, `useSenderKeys`, `administered`
**RoomUser** (`room-user.entity.ts`): `roomId`, `userId`, `username`, `joinedAt`
**UserDevice** (`user-device.entity.ts`): `userId` + `deviceId` (unique pair), `registrationId`, `identityPublicKey`, `authPublicKey` (nullable — per-device server-auth credential, ADR-0010), `status` (`active`/`pending_link`/`revoked`), `deviceName`, `userAgent`, `lastActiveAt`, `revokedAt`
**DeviceLinkSession** (`device-link-session.entity.ts`): `sessionId` (base64url 32B, unique), `primaryUserId?`/`primaryDeviceId?` (set at `/share-pubkey`), `ephemeralPublicKey` (E_pub from `/init`), `encryptedPayload?` (set at `/complete`), `primaryEphemeralPubKey?` (set at `/share-pubkey`), `assignedDeviceId?` (set at `/complete`), `status` (`waiting`/`pubkey-shared`/`completed`/`consumed`/`expired`), `expiresAt`, `consumedAt` — 5min TTL, one-time-use on `/result`, cascade on user delete
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
- `POST /auth/identity` - Authenticate with signed challenge (body: `{ identityPublicKey, challengeId, challengeSignature, registrationId, deviceId, signedPreKey..., deviceAuthSignature? }`). `challengeSignature` must sign the domain-separated message `utf8("TilliT-Auth-Challenge-v1\n" + host + "\n") || nonce`, not the raw nonce. The server validates the request `Host` header against `AUTH_ALLOWED_HOSTS`. **deviceId is also validated**: a new account requires `deviceId === 1` (primary); for an existing user, a non-primary `deviceId` must match an `active` or `pending_link` row in `user_devices` — unknown/revoked devices get `401`. **Per-device server-auth (ADR-0010)**: if the `user_devices` row has an `auth_public_key` bound, the request must carry a valid `deviceAuthSignature` (XEdDSA over the same domain-separated challenge message); missing/invalid → `401 DEVICE_AUTH_INVALID`. Rows without a bound auth key are in transition mode (identity-only auth) unless `DEVICE_AUTH_REQUIRED=true`, which then returns `401 DEVICE_AUTH_REQUIRED`. **Liveness lock (ADR-0011)**: the primary (`deviceId=1`) refreshes the account's liveness anchor on login/refresh/connect; a linked device (`deviceId !== 1`) is refused with `401 PRIMARY_INACTIVE` while the primary has been idle past `PRIMARY_LIVENESS_MAX_IDLE_MS` (soft, reversible — unlocks when the primary returns). See `_shared/api/auth-challenge-domain-separation.md` and `_shared/api/per-device-server-auth.md`.
- `GET /auth/status` - Server reachability + ban check (JwtAuthGuard). Returns `{ status: 'ok' }` on success, or 401 with `error: 'BANNED'` if banned (standard 401 if token invalid/missing). If server is unreachable, client handles as offline.
- `POST /auth/refresh` - Refresh JWT token

**Multi-device pairing** (`/auth/devices`, wire v2.1) — see `_shared/api/multi-device-linking.md` for the full wire contract and `_shared/decisions/0004-symmetric-safety-number.md` for the rationale of the symmetric safety-number step.
- `POST /auth/devices/link/init` - **New device** starts the session (anonymous). Body: `{ ephemeralPublicKey, deviceName?, userAgent? }`. Returns `{ sessionId, expiresAt }`. Per-IP rate limit + global soft cap of `MULTI_DEVICE_OPEN_TOKEN_CAP` open `waiting` sessions → 429 `TOO_MANY_LINKS`.
- `POST /auth/devices/link/share-pubkey` - **Primary** (JWT `deviceId === 1`) shares its `P_pub` ahead of `/complete`: `{ sessionId, primaryEphemeralPublicKey }`. Server attaches `primary_user_id/primary_device_id` from the JWT, saves `P_pub` and flips `status='pubkey-shared'`. Idempotent for the same `P_pub` (no-op); 409 `PUBKEY_MISMATCH` for a different `P_pub` or a different primary; 409 `SESSION_NOT_WAITING` if not in `waiting`; 410 `SESSION_EXPIRED` if the 5-min TTL is past. Response: `{ ok: true }`.
- `POST /auth/devices/link/complete` - **Primary** (JWT `deviceId === 1`) deposits the ECDHE+AES-GCM ciphertext: `{ sessionId, encryptedPayload }`. Requires `status='pubkey-shared'` (409 `SESSION_NOT_PUBKEY_SHARED` otherwise). Server assigns a monotonic `deviceId`, creates a `pending_link` row, flips to `completed`. 409 `DEVICE_LIMIT_REACHED` at 5 active devices; 409 `PUBKEY_MISMATCH` if a different primary tries to commit.
- `GET /auth/devices/link/session/:sessionId/result` - **New device** polls (anonymous, one-time-use only on `completed`). Shapes per status: `pending` → `{ status }`; `pubkey-shared` → `{ status, primaryEphemeralPublicKey, primaryUserId, identityKeyPub }` (the server looks up `identityKeyPub` from `users.identity_public_key`, so the new device can compute its own SN before /complete; 409 `PRIMARY_IDENTITY_NOT_PUBLISHED` if the primary has no identity on record); `completed` → same four fields plus `encryptedPayload` and `assignedDeviceId`. After first read with `status='completed'` the row flips to `consumed` and the ciphertext + `P_pub` are dropped. Subsequent reads return 410 `SESSION_ALREADY_CONSUMED`.
- `GET /auth/devices` - List devices (primary-only); fields include `deviceName`, `status`, `isPrimary`, `isCurrent`, `lastSeen`, `userAgent`.
- `DELETE /auth/devices/me` - Self-logout for any linked device (primary itself uses `DELETE /auth/account` instead).
- `DELETE /auth/devices/:id` - Primary revokes a linked device; server drops the device's pre-keys, emits `deviceRevoked` to peers and to the revoked device itself, then force-disconnects its sockets. Subsequent authenticated requests from that JWT return 401 `DEVICE_REVOKED`.

**Signal Keys** (`/keys`):
- `POST /keys` - Upload pre-keys, identity key and registrationId for the calling device. A new linked device's row flips from `pending_link` to `active` here.
- `GET /keys/:userId` - Fetch the user's key bundle(s). Returns `{ userId, devices: [{ deviceId, identityKey, registrationId, signedPreKey, preKey, kyberPreKey }], ... }` — one entry per active device. Top-level `signedPreKey/preKey/kyberPreKey/deviceId` mirror `devices[0]` for backward compat with v0.x single-device clients. `deviceName` is intentionally **not** exposed to peers (ADR-0001 P-2) — only the primary sees device names via `GET /auth/devices`.

**Sender Keys** (`/sender-keys`):
- `POST /sender-keys/initialize/:roomId` - Switch a room to sender-key mode (returns `distributionId`)
- `POST /sender-keys/distribute/:roomId` - Distribute the sender's key. Each `distributions[]` item is `{ recipientUserId, recipientDeviceId?, encryptedSenderKey }` — multi-device callers pass one entry per `(recipientUser, recipientDevice)`. Pairing-time self-distribution to a freshly linked device is allowed (sender ≠ same `recipientDeviceId`).
- `PUT /sender-keys/mark-delivered` - Acknowledge delivery of distributions
- `GET /sender-keys/active/:roomId` - Get the caller's active distribution for the room
- `GET /sender-keys/:roomId` - Retrieve pending sender-key distributions for the caller's device. Each item:
  `{ id, senderUserId, senderDeviceId, recipientDeviceId, distributionId, encryptedSenderKey, createdAt }`.
  `senderDeviceId`/`recipientDeviceId` default to `1` for rows written before the multi-device fan-out.
- `POST /sender-keys/rotate/:roomId` - Rotate (new distribution)

**Moderation** (`/moderation`):
- `POST /moderation/report` - Report a user or message (body: `{ reportedUserId, roomId, messageId?, reason, description? }`). Reasons: `spam`, `harassment`, `illegal_content`, `other`. Reporter must be room member.

### Ban Enforcement

Banned users are blocked at 3 levels: JWT strategy (all REST), auth service (login/refresh), WebSocket adapter (socket connections). `BanModule` is global with in-memory cache. CLI commands: `tillit moderation ban/unban/banned`. REST ban responses return 401 with `error: 'BANNED'`; WebSocket ban returns `Error.message === 'BANNED'`.

### WebSocket Events

**Client → Server**:
- `sendMessage` - Send user message envelope. Body `{ roomId, id?, message? | recipients?, category?, type?, volatile? }`. Multi-device fan-out path: pass `recipients: [{ userId, deviceId, ciphertext }]` and the server delivers one envelope per `(userId, deviceId)` socket, queuing offline devices individually. Legacy single-ciphertext path with `message` is still supported. Optional `id` (UUID) becomes `envelope.id` for every recipient — lets the sender match `delivered`/`read` receipts (`id_message = envelope.id`) against its locally stored optimistic row; falls back to a server-minted uuid when absent. Offline non-self recipients get a push notification (best-effort); the sender's own user is excluded — no self-sync push (Signal Desktop / WhatsApp Web semantics). Spec: `_shared/api/multi-device-fanout.md`.
- `sendPacket` - Send control packet envelope. Body `{ roomId, packet? | recipients?, recipientIds?, volatile? }`. Per-device fan-out path: pass `recipients: [{ userId, deviceId, packet }]` for X3DH or other device-targeted control packets — one `newPacket` per `(userId, deviceId)` socket, offline targets queued per-`(userId, deviceId, roomId)`. Legacy single-packet broadcast with `packet + recipientIds?` is still supported for user-wide control packets (presence, etc.). Control packets never push. Spec: `_shared/api/multi-device-fanout.md`.
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
- `deviceLinked` - Emitted to the primary when a new linked device finishes pairing `{ deviceId, deviceName, linkedAt }`
- `deviceRevoked` - Emitted to peers (`{ self: false, userId, revokedDeviceId, revokedAt }`) and to the revoked device itself (`{ self: true, byUserId, revokedDeviceId, revokedAt }`)
- `peerDeviceLinked` - Emitted to every peer (user sharing at least one room with the linked user) once a new device of that user becomes `ACTIVE`. Payload: `{ userId, addedDeviceId, linkedAt }`. NOT emitted to the linked user itself. Best-effort signal to invalidate the client-side `(userId, deviceId)` cache; offline peers re-discover the device via `GET /keys/:userId` on reconnect. Spec: `_shared/api/peer-device-linked.md`.
- `senderKeysAvailable` - Notify a recipient (or specific recipient device) that a new sender-key distribution is pending

### Message Flow (Backend Side)

**Envelope shape**: `{ id, roomId, senderId, senderDeviceId?, message, timestamp, category?, type?, version }`. `senderDeviceId` is forwarded from the sender's JWT — clients use it on sender-key flows to address libsignal's per-device store with `(senderId, deviceId)` instead of hardcoding `1`. Absent on legacy envelopes (pre-fix `pending_messages`); client falls back to `1`. See `_shared/api/sender-key-device-id.md`.

**Sending**: Client emits `sendMessage` → backend validates room membership → generates UUID + timestamp → relays to room via `deliverToRoomWithAck()` → non-acking sockets get messages queued in `pending_messages`

**Control packets**: Client emits `sendPacket` → backend relays via `sendControlPacket()` (legacy single-packet, optionally targeted via `recipientIds`) or `fanOutPacketToRecipients()` (per-device fan-out via `recipients[]`) → volatile packets skip offline queue → control packets never push

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
| `AUTH_ALLOWED_HOSTS` | (derived) | Comma-separated hostnames accepted by `POST /auth/identity`. Defaults to a single host extracted from `APP_URL` or `DOMAIN`; rejects everything when nothing is configured. |
| `MULTI_DEVICE_CAP` | 5 | Max active+pending_link devices per user (multi-device pairing) |
| `DEVICE_AUTH_REQUIRED` | false | When true, `POST /auth/identity` rejects devices without a bound `auth_public_key` with `401 DEVICE_AUTH_REQUIRED` (per-device server-auth, ADR-0010 OQ-5) |
| `PRIMARY_LIVENESS_MAX_IDLE_MS` | 604800000 (7d) | Liveness lock (ADR-0011): max idle time of the primary before linked devices are refused with `401 PRIMARY_INACTIVE` (soft, reversible) |
| `PRIMARY_LIVENESS_SWEEP_MS` | 600000 (10min) | Liveness lock (ADR-0011 / backend-0022): interval of the periodic gateway sweep that force-disconnects already-connected linked sockets whose primary has gone stale. Real abuse window = `PRIMARY_LIVENESS_MAX_IDLE_MS + PRIMARY_LIVENESS_SWEEP_MS` |
| `MULTI_DEVICE_OPEN_TOKEN_CAP` | 1000 | Global soft cap on open `waiting` pairing sessions (anti-flood for the anonymous `/link/init` endpoint) |
| `DEVICE_LINK_TTL_MS` | 300000 (5min) | TTL of a pairing session at each step (init/complete window + result window) |
| `DEVICE_LINK_CLEANUP_INTERVAL_MS` | 60000 | Background sweeper interval for expired pairing sessions |

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
