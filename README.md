<p align="center">
  <img src="https://raw.githubusercontent.com/tillit-cc/.github/main/profile/logo.png" alt="TilliT" width="120" />
</p>

<h1 align="center">TilliT</h1>

<p align="center">
  Run your own private messaging server in minutes.<br>
  No phone number. No account. Your own hardware.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL-3.0"></a>
</p>

> **Experimental — not production ready.**
> TilliT is in early development. The core works (encryption, messaging, Tor, media) but expect rough edges, breaking changes, and missing features.
> **We're looking for early testers** — if you're comfortable with a terminal and want to try a different approach to private messaging, [start here](#quick-start).

## How it works

You install TilliT on a Raspberry Pi, mini-PC, or any server. Your messages are encrypted on your phone before they leave — the server only relays opaque blobs it cannot read. No central authority, no metadata collection.

```
Phone A ── E2E encrypted ──> Your TilliT Server ── E2E encrypted ──> Phone B
              (Signal Protocol)       (relay only)       (Signal Protocol)
```

**What makes it different:**
- **No phone number, no email** — authentication via cryptographic key pair
- **No central server** — each instance is independent, you own everything
- **Tor built-in** — server and mobile app support `.onion` natively, zero config
- **Runs on a Raspberry Pi** — ~100-150MB RAM, SQLite, no external dependencies

## Quick Start

One command to install (Docker required on Linux, Docker Desktop on macOS):

```bash
# Linux / Raspberry Pi
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo bash

# macOS (no sudo needed)
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | bash
```

The interactive installer asks how you want to expose your server:

| Option | What it does | Needs |
|--------|-------------|-------|
| **Tor Hidden Service** (default) | Anonymous `.onion` address, zero config | Nothing |
| **Cloudflare Tunnel** | Public HTTPS, no port forwarding | Cloudflare account (free) |
| **HTTPS** | Let's Encrypt via DNS-01 | TilliT Cloud credentials |
| **HTTP** | Plain HTTP on custom port | Port forwarding / VPN |

After install, use `tillit status` to check your server and `tillit help` for all commands.

**Raspberry Pi?** See the [zero-terminal setup guide](docs/raspberry-pi-setup.md) — flash the SD card, run one script, plug in the Pi, done.

## Mobile App

The TilliT app is in open beta with **native Tor support** (arti on iOS, ctor on Android) — no extra apps or proxies needed.

<p align="center">
  <a href="https://testflight.apple.com/join/9QFM35GD"><img src="https://img.shields.io/badge/TestFlight-Join%20Beta-blue?logo=apple&logoColor=white&style=for-the-badge" alt="TestFlight"></a>&nbsp;&nbsp;
  <a href="https://play.google.com/store/apps/details?id=com.oglut.tillit.xnative"><img src="https://img.shields.io/badge/Google%20Play-Join%20Beta-green?logo=googleplay&logoColor=white&style=for-the-badge" alt="Google Play"></a>
</p>

Install the app, point it at your server address (IP, domain, or `.onion`), and start chatting. The app handles key generation, session setup, and encryption transparently.

## What works today

- End-to-end encrypted 1:1 and group messaging (Signal Protocol)
- Room-based chat with invite codes
- Encrypted media (photos, files) with optional ephemeral mode
- Offline message queue (7-day TTL, delivered on reconnect)
- Tor Hidden Service with native client support
- Cloudflare Tunnel and HTTPS deployment modes
- DDNS with automatic `<box-id>.tillit.cc` domain
- Push notifications (iOS + Android)
- CLI management tool (`tillit status`, `tillit logs`, `tillit update`)
- Bare-metal and Docker installation on Linux, macOS, Raspberry Pi

## Who this is for

- People who want messaging without giving up a phone number
- Privacy enthusiasts who want to control their own infrastructure
- Small groups (family, team, friends) who want a private channel
- Developers interested in Signal Protocol implementations
- Anyone curious about self-hosted alternatives to centralized chat

---

## Technical Details

Everything below is for developers and contributors. If you just want to use TilliT, the [Quick Start](#quick-start) and [Mobile App](#mobile-app) sections above are all you need.

### Architecture

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

### Encryption

TilliT implements the Signal Protocol for end-to-end encryption:

- **Double Ratchet** with X3DH key agreement for forward secrecy
- **Kyber post-quantum keys** for future-proofing against quantum attacks
- **Sender keys** for efficient group messaging (single ciphertext per message)
- **Challenge-response authentication** — no passwords, Ed25519 key signatures
- **Zero-knowledge server** — stores only public keys, relays opaque encrypted envelopes

See [`docs/signal-protocol.md`](docs/signal-protocol.md) for the full security architecture.

### Network Modes

| Mode | Compose file | Access | Port forwarding | External account |
|------|-------------|--------|-----------------|------------------|
| **Tor Hidden Service** | `docker-compose.tor.yml` | `http://<hash>.onion` | No | No |
| **Cloudflare Tunnel** | `docker-compose.tunnel.yml` | `https://<domain>` | No | Cloudflare |
| **HTTPS** | `docker-compose.https.yml` | `https://<box>.tillit.cc` | Yes | TilliT Cloud |
| **HTTP** | `docker-compose.selfhosted.yml` | `http://<ip>:3000` | Yes | No |

#### Tor Hidden Service

```bash
mkdir -p /opt/tillit && cd /opt/tillit

curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/docker-compose.tor.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/Dockerfile.tor -o Dockerfile.tor
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/.env.selfhosted.sample -o .env

docker compose up -d

# Wait ~60s for Tor bootstrap, then get your .onion address
docker compose exec tor cat /var/lib/tor/hidden_service/hostname
```

**How it works:**

```
Client ──Tor──> .onion:80 ──> tor container ──> tillit:3000
                               (sidecar)        (internal only)
```

- The `tillit` container runs on an **internal Docker network** with no internet access
- The `tor` sidecar bridges the Tor network to tillit
- Port 3000 is bound to `127.0.0.1` only (local health checks, not exposed externally)
- Cloud services are disabled to prevent clearnet IP leaks

See [`docs/self-hosted-dns.md`](docs/self-hosted-dns.md) for all network options in detail.

### Deployment Modes

| Mode | Database | Redis | Target |
|------|----------|-------|--------|
| `selfhosted` | SQLite | No | Raspberry Pi, mini-PC, single-board |
| `cloud` | MariaDB | Yes | AWS EKS, Kubernetes, multi-instance |

Set via `DEPLOYMENT_MODE` environment variable (default: `cloud`).

### Installation Options

#### Docker (manual)

```bash
mkdir -p /opt/tillit && cd /opt/tillit

curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/docker-compose.selfhosted.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/.env.selfhosted.sample -o .env

nano .env
docker compose up -d
curl http://localhost:3000/health
```

#### Bare-metal (no Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install-bare.sh | sudo bash
```

#### Development

```bash
git clone https://github.com/tillit-cc/tillit.git
cd tillit
pnpm install

cp .env.sample .env

mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

pnpm run start:dev
```

### API Reference

#### REST Endpoints

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

#### WebSocket Events

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

### Configuration

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

### Project Structure

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

### Security

- **Signal Protocol** — industry-standard E2E encryption with forward secrecy
- **Challenge-response auth** — no passwords, authentication via Ed25519 key signatures
- **Server-side rate limiting** — ThrottlerGuard on all endpoints
- **Input validation** — ValidationPipe on all REST and WebSocket handlers
- **Atomic operations** — Redis GETDEL for one-time challenge consumption
- **Path traversal protection** — media storage validates all file paths
- **Tor network isolation** — in onion mode, the backend has no direct internet access

See [SECURITY.md](SECURITY.md) for our security policy and how to report vulnerabilities.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features, including server management via app and server federation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [AGPL-3.0](LICENSE) license.