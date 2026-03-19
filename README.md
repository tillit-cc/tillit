<p align="center">
  <img src="https://raw.githubusercontent.com/tillit-cc/.github/main/profile/logo.png" alt="TilliT" width="120" />
</p>

<h1 align="center">TilliT Backend</h1>

<p align="center">
  End-to-end encrypted chat server with Signal Protocol.<br>
  Self-hosted, zero-knowledge, plug & play — designed to run on dedicated hardware.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL-3.0"></a>
</p>

> **Pre-release** — The backend is functional and in open beta testing. The mobile app source code and public App Store release are coming soon.

## What is TilliT

TilliT is a privacy-first chat system where **the server never sees your messages**. It implements the Signal Protocol (Double Ratchet + X3DH) for end-to-end encryption, with post-quantum security via Kyber keys.

Each deployment runs on dedicated hardware (Raspberry Pi, mini-PC, or cloud) — plug & play, no central server, no metadata collection, no trust required.

```
┌─────────────┐       E2E encrypted         ┌─────────────┐
│  TilliT App │ <────────────────────────── │  TilliT App │
│  (iOS/And)  │                             │  (iOS/And)  │
└──────┬──────┘                             └──────┬──────┘
       │ WSS                                       │ WSS
       └──────────────────┬────────────────────────┘
                          │
                ┌─────────┴─────────┐
                │   TilliT Backend  │
                │   (this repo)     │
                │                   │
                │  - Message relay  │
                │  - Key storage    │
                │  - Offline queue  │
                │  - Media storage  │
                │  - DDNS client    │
                │                   │
                │  SQLite | MariaDB │
                └───────────────────┘
```

## Features

- **Signal Protocol encryption** — Double Ratchet, X3DH key agreement, Kyber post-quantum keys
- **Zero-knowledge server** — relays encrypted blobs, never accesses plaintext
- **Dual deployment mode** — SQLite for self-hosted, MariaDB + Redis for cloud
- **Offline message queue** — messages stored encrypted until recipient reconnects
- **Encrypted media storage** — files encrypted client-side, server stores opaque blobs
- **Sender keys** — efficient group messaging with a single ciphertext per message
- **DDNS with automatic HTTPS** — boxes get `<box-id>.tillit.cc` with Let's Encrypt via DNS-01
- **Tor Hidden Service** — plug & play `.onion` access, zero config, built-in client support
- **Push notifications** — via Expo (iOS + Android)
- **Lightweight** — runs on Raspberry Pi 4 with ~100-150MB RAM

## Mobile App

The TilliT mobile app is in open beta with built-in Tor support (arti on iOS, ctor on Android). Join and test it now:

[![TestFlight](https://img.shields.io/badge/TestFlight-Join%20Open%20Beta-blue?logo=apple)](https://testflight.apple.com/join/9QFM35GD)
[![Google Play](https://img.shields.io/badge/Google%20Play-Join%20Open%20Beta-green?logo=googleplay)](https://play.google.com/store/apps/details?id=com.oglut.tillit.xnative)

The mobile app source code and public store releases are coming soon.

## Quick Start

### Docker (recommended)

```bash
# Linux / Raspberry Pi
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo bash

# macOS (no sudo needed — Docker Desktop runs as current user)
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | bash
```

Or manually:

```bash
mkdir -p /opt/tillit && cd /opt/tillit

# Download files
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/docker-compose.selfhosted.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/.env.selfhosted.sample -o .env

# Edit configuration
nano .env

# Start
docker compose up -d

# Verify
curl http://localhost:3000/health
```

### Bare-metal (no Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install-bare.sh | sudo bash
```

### Development

```bash
# Clone and install
git clone https://github.com/tillit-cc/tillit.git
cd tillit
pnpm install

# Copy environment template
cp .env.sample .env
# Edit .env with your configuration

# Generate RSA keys for JWT
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

# Start in development mode
pnpm run start:dev

# Or with explicit deployment mode
pnpm run start:selfhosted:dev   # SQLite, no Redis
pnpm run start:cloud:dev        # MariaDB + Redis
```

## Network Modes

TilliT supports four ways to expose your server. The interactive installer (`install.sh`) lets you pick one, or you can set up manually:

| Mode | Compose file | Access | Port forwarding | External account |
|------|-------------|--------|-----------------|------------------|
| **Tor Hidden Service** | `docker-compose.tor.yml` | `http://<hash>.onion` | No | No |
| **Cloudflare Tunnel** | `docker-compose.tunnel.yml` | `https://<domain>` | No | Cloudflare |
| **HTTPS** | `docker-compose.https.yml` | `https://<box>.tillit.cc` | Yes | TilliT Cloud |
| **HTTP** | `docker-compose.selfhosted.yml` | `http://<ip>:3000` | Yes | No |

### Tor Hidden Service

Anonymous access via `.onion` — no port forwarding, no domain, no accounts. The address auto-generates on first start and persists across restarts.

```bash
mkdir -p /opt/tillit && cd /opt/tillit

# Download files
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/docker-compose.tor.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/Dockerfile.tor -o Dockerfile.tor
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/.env.selfhosted.sample -o .env

# Start (builds Tor sidecar on first run, ~2-3 min on RPi)
docker compose up -d

# Wait ~60s for Tor bootstrap, then get your .onion address
docker compose exec tor cat /var/lib/tor/hidden_service/hostname
```

Or via the interactive installer:

```bash
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo bash
# Select option 1: Tor Hidden Service (default)
# On macOS: omit sudo
```

**How it works:**

```
Client ──Tor──> .onion:80 ──> tor container ──> tillit:3000
                               (sidecar)        (internal only)
```

- The `tillit` container runs on an **internal Docker network** with no internet access
- The `tor` sidecar is the only egress point — it bridges the Tor network to tillit
- Port 3000 is bound to `127.0.0.1` only (for local health checks, not exposed externally)
- Cloud services (DDNS, push relay) are disabled to prevent clearnet IP leaks

**Client support:** the TilliT mobile app has built-in Tor support (arti on iOS, ctor on Android) — no extra apps needed.

See [`docs/self-hosted-dns.md`](docs/self-hosted-dns.md) for all network options in detail.

## Deployment Modes

| Mode | Database | Redis | Target |
|------|----------|-------|--------|
| `selfhosted` | SQLite | No | Raspberry Pi, mini-PC, single-board |
| `cloud` | MariaDB | Yes | AWS EKS, Kubernetes, multi-instance |

Set via `DEPLOYMENT_MODE` environment variable (default: `cloud`).

## API Reference

### REST Endpoints

All endpoints except `/auth/challenge` and `/auth/identity` require JWT authentication via `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/challenge` | Request authentication challenge nonce |
| `POST` | `/auth/identity` | Authenticate with signed challenge |
| `GET` | `/auth/token/refresh` | Refresh JWT token |
| `POST` | `/auth/token/push` | Register push notification token |
| `GET` | `/auth/v1/users/me` | Get current user |
| `PUT` | `/chat` | Create new room |
| `POST` | `/chat/:code` | Join room by invite code |
| `GET` | `/chat/:id/members` | Get room members |
| `DELETE` | `/chat/:id` | Delete/leave room |
| `GET` | `/chat` | Get all rooms |
| `POST` | `/keys` | Upload Signal Protocol keys |
| `GET` | `/keys/:userId` | Get key bundle for user |
| `GET` | `/keys/status/self` | Get own key status |
| `POST` | `/media/upload` | Upload encrypted media |
| `GET` | `/media/:id` | Download encrypted media |
| `GET` | `/health` | Health check |

### WebSocket Events

Connect to `/chat` namespace with `Bearer <token>` in auth.

**Client -> Server:**

| Event | Payload | Description |
|-------|---------|-------------|
| `sendMessage` | `{ roomId, message, category?, type?, volatile? }` | Send encrypted message |
| `sendPacket` | `{ roomId, packet, recipientIds? }` | Send control packet |
| `joinRoom` | `{ roomId }` | Join room's WebSocket channel |
| `leaveRoom` | `{ roomId }` | Leave room's WebSocket channel |

**Server -> Client:**

| Event | Description |
|-------|-------------|
| `newMessage` | Incoming message envelope |
| `newPacket` | Incoming control packet |
| `userJoined` | User joined room |
| `userLeft` | User left room |
| `userOnline` | User came online |

## Configuration

See [`.env.sample`](.env.sample) for cloud mode and [`.env.selfhosted.sample`](.env.selfhosted.sample) for self-hosted mode.

Key environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DEPLOYMENT_MODE` | `cloud` or `selfhosted` | `cloud` |
| `APP_PORT` | HTTP port | `3000` |
| `JWT_EXPIRES_IN` | JWT token expiry | `7d` |
| `CORS_ORIGIN` | Allowed origins (`true` for all) | `true` |
| `DDNS_ENABLED` | Enable DDNS registration | `false` |
| `MEDIA_MAX_SIZE` | Max upload size (bytes) | `10485760` |
| `MEDIA_RETENTION_DAYS` | Days before media cleanup | `30` |

## Project Structure

```
src/
├── auth/                  # Authentication (JWT, challenge-response)
├── config/                # Configuration modules (app, jwt, ddns, media)
├── database/              # Database adapters (MariaDB, SQLite), migrations
├── entities/              # TypeORM entities
├── modules/
│   ├── chat/              # Chat module (gateway, controllers, services)
│   ├── keys/              # Signal Protocol key management
│   ├── sender-keys/       # Sender key distribution for groups
│   ├── media/             # Encrypted media blob storage
│   └── ddns/              # Dynamic DNS client
├── services/              # Shared services (push notifications)
├── sockets/               # WebSocket adapter with authentication
└── main.ts                # Application entry point
```

## Security

TilliT is designed with security as a first principle:

- **Signal Protocol** — industry-standard E2E encryption with forward secrecy
- **Challenge-response auth** — no passwords, authentication via Ed25519 key signatures
- **Server-side rate limiting** — ThrottlerGuard on all endpoints
- **Input validation** — ValidationPipe on all REST and WebSocket handlers
- **Atomic operations** — Redis GETDEL for one-time challenge consumption
- **Path traversal protection** — media storage validates all file paths
- **Tor network isolation** — in onion mode, the backend has no direct internet access (internal Docker network), preventing IP leaks

See [SECURITY.md](SECURITY.md) for our security policy and how to report vulnerabilities.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features, including server management via app and server federation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [AGPL-3.0](LICENSE) license.
