# Roadmap

This document outlines the planned direction for TilliT. Priorities may shift based on community feedback and contributions.

## Current Status

TilliT is a working end-to-end encrypted chat system with:

- Signal Protocol encryption (Double Ratchet, X3DH, Kyber post-quantum)
- Mobile app (iOS + Android) with built-in Tor support
- Plug & play self-hosted deployment (Raspberry Pi, mini-PC, VPS)
- Tor Hidden Service as default network mode (zero config, no accounts needed)
- Multiple network options: Tor, Cloudflare Tunnel, HTTPS with Let's Encrypt, HTTP
- Cloud deployment mode (MariaDB + Redis + Kubernetes)
- Offline message queue, encrypted media, push notifications
- DSA-compliant reporting system and user ban enforcement
- CLI management tool (`tillit-cli`)

---

## Phase 1 — Server Management via App

> Allow the server admin to configure and manage their TilliT instance directly from the mobile app, without needing SSH access.

**Goal**: Make self-hosted servers truly plug-and-play for non-technical users.

Planned features:

- [ ] Admin role system (first registered user = admin, or configurable)
- [ ] Admin guard for protected API endpoints
- [ ] Server settings management from app (network, DDNS, push, logging)
- [ ] Moderation dashboard in-app (view reports, ban/unban users)
- [ ] Server status and diagnostics (uptime, connected users, storage usage)
- [ ] Admin-only actions restricted to local network or authenticated admin

---

## Phase 2 — Server Federation

> Enable communication between independent TilliT servers, so users on different servers can chat with each other while maintaining the zero-knowledge architecture.

**Goal**: Break the isolation between self-hosted instances without compromising privacy.

Planned features:

- [ ] Server identity and discovery protocol (server-to-server key exchange)
- [ ] Federated user addressing (e.g., `user@server-id`)
- [ ] Cross-server room creation and message relay
- [ ] Cross-server Signal Protocol session establishment
- [ ] Trust model for federation (allowlist, mutual authentication, or open)
- [ ] Federated media relay for encrypted attachments

---

## How to Contribute

Have ideas or want to help? Here's how:

- **Discuss**: Open a [GitHub Discussion](https://github.com/tillit-cc/tillit/discussions) to propose features or share feedback
- **Issues**: Check [open issues](https://github.com/tillit-cc/tillit/issues) for tasks you can pick up
- **PRs**: See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines

Feature requests and roadmap suggestions are welcome as GitHub Issues with the `roadmap` label.