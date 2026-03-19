# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in TilliT, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

### How to Report

Send an email to **security@tillit.cc** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

### What to Expect

- **Acknowledgement** within 48 hours
- **Assessment** within 1 week
- **Fix timeline** communicated after assessment
- **Credit** in the release notes (unless you prefer anonymity)

## Scope

The following are in scope:

- Authentication bypass
- Encryption weaknesses
- Server-side injection (SQL, command, etc.)
- Information disclosure (plaintext leaks, key exposure)
- Denial of service against the self-hosted instance
- WebSocket security issues
- Path traversal in media storage

## Out of Scope

- Client-side vulnerabilities in the mobile app (report to the app repository)
- Social engineering
- Physical attacks against hardware
- Vulnerabilities in third-party dependencies (report upstream, but let us know)

## Security Measures

TilliT implements the following security measures:

- **Signal Protocol** for end-to-end encryption (Double Ratchet + X3DH + Kyber)
- **Challenge-response authentication** with Ed25519 signatures
- **Rate limiting** on all endpoints (ThrottlerGuard)
- **Input validation** on all REST and WebSocket handlers
- **Atomic challenge consumption** to prevent replay attacks
- **Path traversal protection** on media storage
- **Generic error messages** to prevent information leakage
- **No plaintext storage** — the server only handles encrypted blobs

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |
| < latest | No      |

We only provide security fixes for the latest release.