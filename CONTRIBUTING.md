# Contributing to TilliT

Thank you for your interest in contributing to TilliT. This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/tillit.git`
3. Install dependencies: `pnpm install`
4. Create a feature branch: `git checkout -b feature/your-feature`
5. Make your changes
6. Run the build: `pnpm run build`
7. Submit a pull request

## Development Setup

```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.sample .env

# Generate RSA keys for JWT
mkdir -p keys
openssl genrsa -out keys/private.pem 2048
openssl rsa -in keys/private.pem -pubout -out keys/public.pem

# Start in development mode (SQLite, no external services needed)
pnpm run start:selfhosted:dev
```

## Code Style

- TypeScript strict mode
- NestJS conventions (modules, controllers, services, DTOs)
- Use NestJS `Logger` instead of `console.log`
- Validate all inputs with `class-validator` decorators
- Use `class-transformer` for DTO transformation

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include a clear description of what changed and why
- Ensure `pnpm run build` passes
- Add tests for new functionality when possible
- Update documentation if you change the API

## Commit Messages

Use clear, descriptive commit messages:

```
feat: add offline message retry mechanism
fix: prevent race condition in challenge consumption
docs: update self-hosting guide for Raspberry Pi 5
```

Prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Security

If you discover a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Architecture Notes

- **Dual deployment mode**: Changes must work in both `cloud` (MariaDB + Redis) and `selfhosted` (SQLite) modes
- **Zero-knowledge principle**: The server must never access or store plaintext message content
- **Lightweight footprint**: Keep RAM usage under 150MB for self-hosted mode
- **Signal Protocol**: Do not modify the encryption layer without thorough review

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.