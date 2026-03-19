# Signal Protocol — Security Architecture

This document describes how the TilliT backend handles end-to-end encryption for security reviewers. The backend is a **zero-knowledge relay**: it never sees plaintext message content, never holds private keys, and cannot decrypt anything it stores or forwards.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication](#2-authentication)
3. [Key Storage](#3-key-storage)
4. [Session Establishment](#4-session-establishment)
5. [Message Relay](#5-message-relay)
6. [Sender Key Protocol](#6-sender-key-protocol)
7. [Offline Message Queue](#7-offline-message-queue)
8. [Encrypted Media](#8-encrypted-media)
9. [Push Notifications](#9-push-notifications)
10. [Database Schema](#10-database-schema)
11. [What the Server Cannot Do](#11-what-the-server-cannot-do)

---

## 1. Overview

TilliT implements the Signal Protocol (Double Ratchet + X3DH key agreement) with post-quantum Kyber keys. All cryptographic operations happen exclusively on the client (mobile app). The server:

- **Stores only public keys** — identity keys, signed pre-keys, one-time pre-keys, Kyber pre-keys
- **Relays opaque envelopes** — encrypted payloads pass through without inspection
- **Never decrypts** — no private keys, no session state, no plaintext at rest or in transit
- **Validates structure, not content** — checks envelope format, room membership, rate limits

**Source files**:
- Entry point: `src/main.ts`
- App module: `src/app.module.ts`

---

## 2. Authentication

TilliT uses **passwordless challenge-response authentication** based on the Signal Protocol identity key (Ed25519). No phone numbers, no emails, no passwords.

### Flow

```
Client                                    Server
  │                                         │
  │  POST /auth/challenge                   │
  │  { identityPublicKey }                  │
  │────────────────────────────────────────►│
  │                                         │  Generate 32-byte random nonce
  │  { challengeId, nonce, expiresIn }      │  Store with TTL (60s)
  │◄────────────────────────────────────────│
  │                                         │
  │  Sign nonce with Ed25519 private key    │
  │                                         │
  │  POST /auth/identity                    │
  │  { identityPublicKey, challengeId,      │
  │    challengeSignature, registrationId,  │
  │    deviceId, signedPreKey... }          │
  │────────────────────────────────────────►│
  │                                         │  Consume challenge (one-time)
  │                                         │  Verify Ed25519 signature
  │                                         │  via libsignal-client
  │                                         │  Create user if new
  │  { accessToken (RS256 JWT), userId }    │  Issue JWT signed with RSA
  │◄────────────────────────────────────────│
```

### Security Properties

- **Challenge is single-use**: consumed atomically on verification (Redis `GETDEL` in cloud mode, `Map.delete()` in self-hosted mode)
- **Challenge TTL**: 60 seconds (configurable via `CHALLENGE_TTL_SECONDS`)
- **No password stored**: authentication proves possession of the Signal identity private key
- **Identity key binding**: challenge is bound to the `identityPublicKey` that requested it — a different key cannot claim it
- **JWT tokens**: RS256 (RSA-SHA256), signed with a server-generated RSA keypair stored at `/opt/tillit/keys/`
- **Rate limited**: `THROTTLE_AUTH_LIMIT` (default 5 requests/60s)

### User Identity

Users are identified solely by their `identityPublicKey` (base64-encoded). There are no usernames, emails, or phone numbers at the server level. If a user uninstalls the app and reinstalls, they generate a new identity key and become a new user.

**Source files**:
- `src/auth/auth.service.ts` — `authenticateByIdentity()`, `verifyChallengeSignature()`
- `src/auth/services/challenge.store.ts` — `ChallengeStore` (dual-mode: Redis / in-memory)
- `src/auth/dto/challenge.dto.ts` — `ChallengeRequestDto`
- `src/auth/dto/identity-auth.dto.ts` — `IdentityAuthDto`

---

## 3. Key Storage

The server stores **only public keys**. Private keys never leave the client device.

### Key Types

| Key Type | ID | Purpose | Lifespan | Consumed |
|---|---|---|---|---|
| **Pre-Key** | 1 | One-time use keys for X3DH | Single use | Yes — marked `consumed = true` after fetch |
| **Kyber Pre-Key** | 2 | Post-quantum key exchange (Kyber) | Single use | Yes — marked `consumed = true` after fetch |
| **Signed Pre-Key** | 3 | Medium-term key signed by identity key | Rotated periodically | No — reusable |

### Storage Model

Keys are stored per `(userId, deviceId)` pair in the `signal_keys` table:

```
signal_keys
├── id              (auto-increment)
├── user_id         (FK → users, CASCADE DELETE)
├── device_id       (string, e.g. "1")
├── key_type        (FK → signal_key_types: 1/2/3)
├── key_id          (integer, client-assigned key identifier)
├── key_data        (text, base64-encoded public key bytes)
├── key_signature   (text, base64, nullable — present for signed + Kyber)
├── consumed        (boolean, default false)
└── created_at      (timestamp)
```

The identity public key is stored separately on the `user_devices` table:

```
user_devices
├── id                  (auto-increment)
├── user_id             (FK → users, CASCADE DELETE)
├── device_id           (integer, unique per user)
├── registration_id     (integer, Signal Protocol registration ID)
├── identity_public_key (text, base64-encoded identity public key)
├── last_active_at      (timestamp, updated on key fetch)
└── created_at          (timestamp)
```

### Key Bundle Fetch

When User A wants to establish a session with User B, the server provides a **key bundle** containing:

1. **Identity key** — from `user_devices` (most recently active device)
2. **Signed pre-key** — most recent, NOT consumed (reusable)
3. **Pre-key** — oldest unconsumed, **marked consumed after fetch** (one-time use)
4. **Kyber pre-key** — oldest unconsumed, **marked consumed after fetch** (one-time use)

The server updates `lastActiveAt` on the device when its keys are fetched.

### Key Upload

Clients upload 25 pre-keys and 25 Kyber pre-keys at registration. When the server detects low key counts, the client is expected to upload more. The `getKeyStatus()` endpoint returns remaining counts.

**Source files**:
- `src/modules/keys/services/keys.service.ts` — `uploadKeys()`, `getAvailableKeysForUser()`, `consumePreKey()`
- `src/entities/signal-key.entity.ts` — `SignalKey` entity, `KeyTypeId` enum
- `src/entities/user-device.entity.ts` — `UserDevice` entity
- `src/entities/signal-key-type.entity.ts` — `SignalKeyType` reference table

---

## 4. Session Establishment

Session establishment uses **X3DH (Extended Triple Diffie-Hellman)** entirely on the client side. The server's role is limited to:

1. Providing the public key bundle (see [Key Storage](#3-key-storage))
2. Relaying the `SESSION_ESTABLISHED` control packets

### Flow

```
User 1 (room creator)                 Server                    User 2 (joiner)
       │                                │                              │
       │  PUT /chat (create room)       │                              │
       │───────────────────────────────►│                              │
       │  { inviteCode }               │                              │
       │◄───────────────────────────────│                              │
       │                                │                              │
       │  WS: joinRoom(roomId)          │                              │
       │───────────────────────────────►│                              │
       │                                │                              │
       │                                │  POST /chat/:code (join)     │
       │                                │◄─────────────────────────────│
       │                                │  { roomId, members }         │
       │                                │─────────────────────────────►│
       │                                │                              │
       │                                │  GET /signal-keys/bundle     │
       │                                │◄─────────────────────────────│
       │                                │  { keyBundle for User 1 }    │
       │                                │─────────────────────────────►│
       │                                │                              │
       │                                │      [X3DH on client]        │
       │                                │      Session → User 1        │
       │                                │                              │
       │                                │  WS: joinRoom(roomId)        │
       │                                │◄─────────────────────────────│
       │                                │                              │
       │  WS: newPacket                 │  WS: sendPacket              │
       │  SESSION_ESTABLISHED           │  { encrypted: false,         │
       │  { encrypted: false,           │    reply: false }            │
       │    reply: false }              │◄─────────────────────────────│
       │◄───────────────────────────────│                              │
       │                                │                              │
       │  GET /signal-keys/bundle       │                              │
       │  (for User 2)                  │                              │
       │───────────────────────────────►│                              │
       │  { keyBundle for User 2 }      │                              │
       │◄───────────────────────────────│                              │
       │                                │                              │
       │  [X3DH on client]              │                              │
       │  Session → User 2              │                              │
       │                                │                              │
       │  WS: sendPacket                │  WS: newPacket               │
       │  SESSION_ESTABLISHED           │  SESSION_ESTABLISHED         │
       │  { encrypted: true,            │  { encrypted: true,          │
       │    reply: true }               │    reply: true }             │
       │───────────────────────────────►│─────────────────────────────►│
       │                                │                              │
       │         ◄── Both sessions established, encrypted chat ──►     │
```

### Critical Details

- The **initial** `SESSION_ESTABLISHED` packet (`reply: false`) is sent **unencrypted** because the recipient doesn't have a session yet to decrypt it
- The **confirmation** (`reply: true`) is sent **encrypted** because both sides now have sessions
- The server relays both packets without inspecting the content
- The `encrypted` flag on the envelope tells the recipient whether to attempt decryption

**Source files**:
- `src/modules/chat/gateways/chat.gateway.ts` — `handleSendPacket()`, `handleJoinRoom()`
- `src/modules/chat/services/message.service.ts` — `sendControlPacket()`

---

## 5. Message Relay

The server is a **dumb relay**. It validates envelope structure and room membership, then forwards to recipients.

### Envelope Structure

```typescript
{
  id: string;           // Server-generated UUID (prevents client spoofing)
  roomId: number;       // Room ID (validated against membership)
  senderId: number;     // Sender user ID (from JWT, not client-provided)
  message: any;         // Opaque encrypted payload (server cannot read)
  timestamp: string;    // Server-generated ISO 8601 timestamp
  category: string;     // Message category
  type: string;         // Message type
  version: string;      // Protocol version
}
```

### What the Server Validates

| Check | Description |
|---|---|
| **Room membership** | Sender must be a member of the room (`room_users` table) |
| **Payload size** | Max 64KB for WebSocket messages (`MAX_WS_PAYLOAD_BYTES`) |
| **Sender ID** | Extracted from JWT token, not from the client payload |
| **Message ID** | Generated server-side (UUID v4), preventing ID collisions |
| **Rate limits** | Global throttle + per-endpoint limits |

### What the Server Does NOT Validate

- Message content (encrypted, opaque)
- Encryption correctness
- Message ordering or deduplication (client responsibility)
- Payload schema beyond basic structure

### Message Categories

| Category | Encrypted | Description |
|---|---|---|
| `user` / `message` | Always | User messages (text, images, etc.) |
| `control` | Usually | Control packets (SESSION_ESTABLISHED, DELIVERED, READ, TYPING). Exception: initial SESSION_ESTABLISHED is unencrypted |
| `system` | Never | Server-generated notifications (userJoined, roomDeleted) |
| `action` | Never | Message actions (edit, delete, reaction) |
| `senderkey_message` | Always | Messages encrypted with sender keys (group optimization) |

### Delivery Model

1. Server emits to each connected socket individually
2. Each socket must acknowledge within `ACK_TIMEOUT_MS` (default 5 seconds)
3. Non-acknowledging sockets are treated as offline
4. Offline users get messages queued in `pending_messages` (see [Offline Message Queue](#7-offline-message-queue))
5. The `volatile` flag skips the offline queue entirely (used for TYPING indicators and other ephemeral control packets)

**Source files**:
- `src/modules/chat/gateways/chat.gateway.ts` — `handleSendMessage()`, `handleSendPacket()`
- `src/modules/chat/services/message.service.ts` — `sendToRoom()`, `deliverToRoomWithAck()`

---

## 6. Sender Key Protocol

Sender keys are an optimization for group messaging. Instead of encrypting a message N times (once per recipient), the sender encrypts once with a symmetric sender key. The sender key itself is distributed encrypted via each recipient's pair-wise Signal session.

### Server's Role

The server **never sees the plaintext sender key**. It stores encrypted copies — each copy is encrypted with a different recipient's pair-wise session:

```
sender_key_distributions
├── room_id                 (which room)
├── sender_user_id          (who generated the key)
├── distribution_id         (UUID, identifies the key batch)
├── encrypted_sender_key    (text, encrypted with recipient's pair-wise session)
├── recipient_user_id       (who this copy is for)
├── delivered               (boolean, has recipient fetched it?)
└── created_at
```

### Flow

```
Sender                          Server                       Recipient A
  │                               │                               │
  │  Generate sender key          │                               │
  │  Encrypt with A's session     │                               │
  │  Encrypt with B's session     │                               │
  │                               │                               │
  │  POST distributeSenderKey     │                               │
  │  [{ recipientUserId: A,      │                               │
  │     encryptedSenderKey }]     │                               │
  │──────────────────────────────►│                               │
  │                               │  Store encrypted copies       │
  │                               │  WS: senderKeysAvailable      │
  │                               │──────────────────────────────►│
  │                               │                               │
  │                               │  WS: requestSenderKeys        │
  │                               │◄──────────────────────────────│
  │                               │  Return encrypted copies      │
  │                               │──────────────────────────────►│
  │                               │                               │
  │                               │     Decrypt with pair-wise    │
  │                               │     session → plaintext       │
  │                               │     sender key                │
  │                               │                               │
  │  WS: sendMessage              │  WS: newMessage               │
  │  (senderkey_message)          │  (relay opaque ciphertext)    │
  │──────────────────────────────►│──────────────────────────────►│
```

### Key Rotation

- When a member leaves a room, the sender key should be rotated (`rotateSenderKey()`)
- Rotation deactivates the current distribution and creates a new `distributionId`
- All members must receive the new sender key before messages can be decrypted

### Metadata Tracking

```
sender_key_metadata
├── room_id
├── distribution_id      (UUID)
├── sender_user_id
├── active               (boolean — only one active per sender per room)
├── created_at
└── rotated_at           (nullable — set when deactivated)
```

**Source files**:
- `src/modules/sender-keys/services/sender-keys.service.ts` — `initializeSenderKeys()`, `distributeSenderKey()`, `rotateSenderKey()`
- `src/entities/sender-key-distribution.entity.ts` — `SenderKeyDistribution` entity
- `src/entities/sender-key-metadata.entity.ts` — `SenderKeyMetadata` entity

---

## 7. Offline Message Queue

When a recipient is offline (WebSocket not connected or doesn't acknowledge), the entire encrypted envelope is stored for later delivery.

### Storage

```
pending_messages
├── id              (UUID)
├── user_id         (FK → users, CASCADE DELETE)
├── room_id         (FK → rooms, CASCADE DELETE)
├── envelope        (text — full JSON-serialized MessageEnvelope)
├── created_at      (bigint, Unix ms)
├── expires_at      (bigint, Unix ms = created_at + TTL)
└── attempts        (integer, delivery attempt count)
```

### Behavior

- **TTL**: 7 days (`PENDING_MESSAGE_TTL_MS`, default `604800000`)
- **Delivery on reconnect**: when a client connects via WebSocket, the server auto-joins all rooms and replays pending messages per room
- **Ack-based deletion**: pending messages are only deleted from the database **after the client acknowledges** receipt
- **Periodic cleanup**: expired messages are purged every hour (`PENDING_CLEANUP_INTERVAL_MS`)
- **Volatile messages**: messages with `volatile: true` (e.g., TYPING indicators) skip the offline queue entirely

### Security Properties

- The `envelope` field contains the **full encrypted envelope** as JSON — the server stores it opaquely
- If an attacker gains database access, they see encrypted blobs, not plaintext
- CASCADE DELETE ensures pending messages are cleaned up when a user or room is deleted

**Source files**:
- `src/entities/pending-message.entity.ts` — `PendingMessage` entity
- `src/modules/chat/services/message.service.ts` — `handleOfflineUsers()`, `deliverPendingToSocket()`

---

## 8. Encrypted Media

Media files (images, videos, documents) are encrypted client-side before upload. The server stores and serves opaque binary blobs.

### Upload Flow

1. Client encrypts file locally (AES-256-GCM or similar, client-side)
2. Client uploads base64-encoded encrypted data via `POST /media` or `POST /media/ephemeral`
3. Server decodes base64 to binary, writes `{uuid}.enc` to filesystem
4. Server stores metadata in `media_blobs` table
5. Client sends a user message containing the media ID (encrypted in the message payload)
6. Recipient decrypts message, extracts media ID, fetches via `GET /media/:id`
7. Server returns raw encrypted bytes (`application/octet-stream`)
8. Recipient decrypts file locally

### Storage Model

```
media_blobs
├── id               (UUID)
├── room_id          (FK → rooms)
├── uploader_id      (FK → users)
├── file_path        (relative path, e.g. "{uuid}.enc")
├── mime_type        (client-declared, server doesn't verify)
├── size             (bytes)
├── created_at       (bigint, Unix ms)
├── expires_at       (bigint, Unix ms)
├── ephemeral        (boolean)
├── max_downloads    (nullable integer)
└── download_count   (integer, default 0)
```

### Ephemeral Media

Ephemeral media adds "view once" semantics:

- **TTL**: capped at `EPHEMERAL_MEDIA_MAX_TTL_HOURS` (default 168h / 7 days)
- **Download tracking**: `media_downloads` table records who downloaded, with unique constraint `(mediaId, userId)` preventing double downloads
- **Auto-delete**: when `downloadCount >= maxDownloads`, file is automatically deleted from filesystem and database
- **View-once**: `POST /media/:id/viewed` immediately deletes the media (idempotent)
- **Late-joiner protection**: users who joined a room after the upload cannot download ephemeral media

### Path Traversal Protection

`resolveStoragePath()` validates that the resolved filesystem path stays within the configured `storageDir`, preventing directory traversal attacks.

### What the Server Sees

The server sees:
- File size
- Client-declared MIME type (unverified — the actual content is encrypted)
- Which user uploaded it
- Which room it belongs to
- Download counts and timestamps

The server does **not** see:
- File contents (encrypted blob)
- File name (not stored)
- Actual file type (MIME type is client-declared, content is encrypted)

**Source files**:
- `src/modules/media/services/media.service.ts` — `upload()`, `download()`, `markViewed()`, `cleanupExpired()`
- `src/modules/media/controllers/media.controller.ts` — REST endpoints
- `src/entities/media-blob.entity.ts` — `MediaBlob` entity
- `src/entities/media-download.entity.ts` — `MediaDownload` entity

---

## 9. Push Notifications

Push notifications are designed to **leak no message content** by default.

### Default Behavior (`PUSH_INCLUDE_DATA=false`)

The server sends a generic localized "New message" notification with:
- `sound: "hp.caf"`
- `priority: "high"`
- Localized title/body based on push token `lang` field (en, it, es, fr, de, pt)
- **No message content, no room name, no sender name**

### Optional Metadata (`PUSH_INCLUDE_DATA=true`)

When enabled, notifications include metadata for quick navigation:
- `roomId`
- `messageId`
- `senderId`

This reveals **which room** received a message and **who sent it**, but never the content.

### Delivery Path

- **Cloud mode**: Direct Expo Push API via Expo SDK
- **Self-hosted + cloud worker**: Push Relay via `POST /push` to `worker.tillit.cc` (the box never holds `EXPO_ACCESS_TOKEN`)
- **Self-hosted fallback**: Direct Expo SDK if `EXPO_ACCESS_TOKEN` is configured locally

### Control Packets

Control packets (TYPING, DELIVERED, READ, SESSION_ESTABLISHED) **never trigger push notifications**, even for offline users.

**Source files**:
- `src/modules/chat/services/message.service.ts` — `sendPushNotificationsToUsers()`
- `src/services/push-relay.service.ts` — `PushRelayService`

---

## 10. Database Schema

Complete overview of what is stored in cleartext vs encrypted.

### Cleartext Data

The following data is stored unencrypted because the server needs it for routing and access control:

| Table | Cleartext Fields | Why |
|---|---|---|
| `users` | `id`, `identityPublicKey`, `registrationId`, timestamps | User lookup, authentication |
| `rooms` | `id`, `inviteCode`, `name`, `status`, `idUser`, `administered`, `useSenderKeys`, timestamps | Room management, invite codes |
| `room_users` | `roomId`, `userId`, `username`, `joinedAt` | Membership checks for message relay |
| `user_devices` | `userId`, `deviceId`, `registrationId`, `identityPublicKey`, `name`, timestamps | Key bundle assembly |
| `signal_keys` | `userId`, `deviceId`, `keyTypeId`, `keyId`, `keyData` (public key), `keySignature`, `consumed` | Key bundle delivery |
| `push_tokens` | `userId`, `token`, `platform`, `provider`, `lang` | Push notification delivery |
| `media_blobs` | `id`, `roomId`, `uploaderId`, `filePath`, `mimeType`, `size`, `ephemeral`, download tracking, timestamps | Media routing and lifecycle |
| `sender_key_metadata` | `roomId`, `distributionId`, `senderUserId`, `active`, timestamps | Sender key state |

### Encrypted Data

| Data | Storage | Encryption |
|---|---|---|
| **Message content** | `pending_messages.envelope` (JSON blob) | Signal Protocol (Double Ratchet) or sender key |
| **Media files** | Filesystem `{uuid}.enc` | Client-side (AES-256-GCM or similar) |
| **Sender keys** | `sender_key_distributions.encryptedSenderKey` | Pair-wise Signal session per recipient |

### Important Notes

- **Room names** are cleartext — they are set by the room creator and visible to the server. If privacy of room names is required, clients can encrypt them and store a display name locally.
- **Usernames** in `room_users` are cleartext — these are optional display names within a room.
- **Identity public keys** are inherently public — they are the public half of a key pair and are designed to be shared.
- **Push tokens** are cleartext — they must be readable by the server (or push relay) to deliver notifications.

### CASCADE Deletes

All foreign keys to `User` have `onDelete: 'CASCADE'`:

```
User deletion triggers:
├── user_devices      → all devices deleted
├── signal_keys       → all keys deleted
├── room_users        → all memberships deleted
├── push_tokens       → all push tokens deleted
├── pending_messages  → all pending messages deleted
├── media_blobs       → all uploaded media deleted
│   └── media_downloads → all download records deleted
├── sender_key_distributions → all distributions deleted
└── sender_key_metadata      → all metadata deleted
```

Room deletion similarly cascades to `room_users`, `pending_messages`, and related records.

---

## 11. What the Server Cannot Do

Explicit guarantees provided by the cryptographic architecture:

| Guarantee | Reason |
|---|---|
| **Cannot read messages** | Messages are encrypted with Signal Protocol (Double Ratchet). Private keys exist only on client devices. |
| **Cannot decrypt media** | Media files are encrypted client-side before upload. Server stores and serves opaque `.enc` blobs. |
| **Cannot forge messages** | Message authentication is part of the Signal Protocol session. Each message is authenticated by the sender's ratchet key. |
| **Cannot impersonate users** | Authentication requires signing a challenge with the Ed25519 identity private key, which only exists on the client device. |
| **Cannot read sender keys** | Sender keys are encrypted per-recipient with pair-wise Signal sessions. Server stores encrypted copies. |
| **Cannot correlate message content** | Even with database access, pending messages are encrypted envelopes. The server cannot determine if two messages have the same content. |
| **Cannot access past messages** | Messages are not stored after delivery (only pending messages for offline users, with 7-day TTL). Once delivered and acknowledged, they exist only on client devices. |
| **Cannot prevent forward secrecy** | The Double Ratchet algorithm generates new keys for each message. Compromise of a current key does not reveal past messages. |
| **Cannot downgrade encryption** | The `encrypted` flag is set by the client-side `MessageEnvelopeFactory`. The server relays it but cannot change it without breaking message authentication. |

### What the Server CAN See (Metadata)

An honest assessment of metadata available to the server:

- **Who is in which room** (room membership)
- **When messages are sent** (timestamps)
- **Message sizes** (envelope size, media file size)
- **Online/offline status** (WebSocket connection state)
- **Which devices a user has** (device registrations)
- **Push token information** (platform, language preference)
- **Room names** (cleartext, set by room creator)
- **IP addresses** (standard for any network service)

This metadata exposure is inherent to any relay-based messaging system. Users who require metadata privacy should consider using TilliT over Tor or a VPN.
