# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security (H-04 pre-open-source audit close-out)

- Sender-key flows now forward the sender's `deviceId` so the client can
  address libsignal's per-device store with `(senderId, deviceId)` instead
  of hardcoding `1`. Not exploitable today (all users on single device) but
  unblocks safe multi-device rollout — without this, two devices of the
  same user would collide in the recipient's sender-key store.
- JWT claims now include `deviceId` (in addition to `sub`). Legacy tokens
  without the claim fall back to `1`, matching today's single-device reality.
- `GET /sender-keys/:roomId` response includes `senderDeviceId` on each
  distribution item (default `1` for rows written before the fix).
- `MessageEnvelope` and `ControlPacket` include optional `senderDeviceId`
  populated from the sender's auth context. Old envelopes already queued in
  `pending_messages` (pre-fix) decode unchanged — client falls back to `1`.
- New migration `1746000000000-add-sender-device-id` (both MariaDB and SQLite)
  adds nullable `sender_device_id` column to `sender_key_distributions`.
- Spec: `_shared/api/sender-key-device-id.md`.

### Security (BREAKING — auth protocol v1)

- `POST /auth/identity` now verifies the challenge signature against a
  domain-separated message `utf8("TilliT-Auth-Challenge-v1\n" + host + "\n") || nonce`
  instead of the raw nonce. Closes a replay attack where a malicious server
  could pick a nonce that doubles as a valid Curve25519 public key, turning the
  auth signature into a reusable `SignedPreKeySignature` for X3DH impersonation.
- Clients running v1.3.x or earlier will fail authentication after this change
  — they sign the raw nonce. Coordinate with client v1.4.0 rollout.
- New env var `AUTH_ALLOWED_HOSTS` (comma-separated). When set, the server
  rejects auth attempts whose `Host` header is not in the allowlist. Falls back
  to `APP_URL`/`DOMAIN` derivation when unset; rejects everything when no
  configuration is found.
- Test vectors pinned at `_shared/api/auth-challenge-test-vectors.json` and
  regenerable via `scripts/generate-auth-challenge-test-vectors.ts`.

## [0.5.0] - 2026-03-19

### Added
- Tor Hidden Service as default network mode (plug & play, zero config)
- `Dockerfile.tor` — minimal Tor sidecar (debian:bookworm-slim + hidden service)
- `docker-compose.tor.yml` — Tor deployment with network isolation (internal network for tillit, egress only for tor)
- `tillit onion` CLI command to display .onion address
- Tor option in all installers: `install.sh`, `install-bare.sh`, `rpi-setup.sh`, `tillit-firstboot.sh`
- Google Play open beta badge in README

### Changed
- Network mode menu reordered: Tor (default) > Cloudflare Tunnel > HTTPS > HTTP
- `tillit update` now rebuilds Tor sidecar with `--build` flag

### Security
- Tor mode: tillit container on internal-only Docker network (no direct internet access)
- Tor mode: port 3000 bound to localhost only (not exposed externally)
- Tor mode: cloud services (DDNS, push relay) force-disabled to prevent clearnet IP leaks
- Tor sidecar: `ExitRelay 0` + `ExitPolicy reject *:*` in torrc
- Bare-metal installer backs up torrc before modification

### Removed
- Dead env vars from `.env.sample`: `SMS_USER_ID`, `SMS_USER_PASSWORD`, `SMS_GATEWAY_URL`, `DEMO_PHONE`, `DEMO_PASSWORD`
- Misleading `JWT_SECRET` from `.env.cloud.sample` (system uses RSA key pairs)

## [0.4.2] - 2026-02-13

### Added
- Media module for encrypted media storage and management
- Configurable cleanup intervals for pending messages and media (`PENDING_CLEANUP_INTERVAL_MS`, `MEDIA_CLEANUP_INTERVAL_MS`)

### Security
- ThrottlerGuard registered as APP_GUARD (global rate limiting)
- Disabled TypeORM `synchronize` in production
- Atomic challenge consumption via Redis GETDEL
- WebSocket DTO validation with ValidationPipe
- Rate limits on `/auth/challenge` (5/min) and `/keys/:userId` (20/min)
- Server-side UUID generation for sender key messages
- Sender key room validation
- Generic error messages (no internal details leaked)
- MaxLength validation on crypto fields
- WebSocket CORS now configurable via `CORS_ORIGIN`

### Removed
- Firebase Admin SDK and related dead code
- Unused dependencies: socket.io-client, passport-local, passport-http, tweetnacl, @noble/curves

## [0.4.1] - 2026-02-09

### Changed
- Updated DDNS worker URL
- Version bump

## [0.4.0] - 2026-02-01

### Added
- Sender keys module for efficient group messaging
- DDNS module with Cloudflare Worker relay
- Dual deployment mode (cloud/selfhosted)
- SQLite adapter for self-hosted mode
- Offline message queue with 7-day TTL
- Expo push notification service
- Docker and bare-metal installation scripts
- HTTPS support via Caddy with DNS-01 challenge
- Hardware provisioning script

## [0.3.0] - 2026-01-15

### Added
- Signal Protocol key management (pre-keys, signed pre-keys, Kyber keys)
- Challenge-response authentication (Ed25519)
- Room-based chat with invite codes
- WebSocket gateway with authenticated adapter
- Redis adapter for multi-instance Socket.IO

## [0.2.0] - 2025-12-01

### Added
- Initial NestJS backend structure
- TypeORM entities and migrations
- JWT authentication with RSA keys
- Health check endpoint
