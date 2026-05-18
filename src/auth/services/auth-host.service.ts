import { Injectable, Logger, BadRequestException } from '@nestjs/common';

/**
 * Resolves the canonical host name that the client used to reach this request,
 * and validates it against a deployment-configured allowlist.
 *
 * Used to bind the `POST /auth/identity` challenge signature to a specific host
 * (domain separation), so a signature produced for one host cannot be replayed
 * against another. See `_shared/api/auth-challenge-domain-separation.md`.
 *
 * Configuration:
 *   AUTH_ALLOWED_HOSTS — comma-separated list of accepted hostnames
 *     (e.g. "api.tillit.cc,abcdef.onion,localhost:3000").
 *     If unset, the service falls back to deriving a single host from APP_URL
 *     or DOMAIN. If neither is configured, every request is rejected at startup
 *     time of the auth flow — the operator must opt in to an allowlist.
 */
@Injectable()
export class AuthHostService {
  private readonly logger = new Logger(AuthHostService.name);
  private readonly allowedHosts: Set<string>;

  constructor() {
    this.allowedHosts = this.loadAllowedHosts();

    if (this.allowedHosts.size === 0) {
      this.logger.warn(
        'AUTH_ALLOWED_HOSTS is empty — POST /auth/identity will reject every ' +
          'request until at least one host is configured (or APP_URL/DOMAIN is set).',
      );
    } else {
      this.logger.log(
        `Auth challenge allowlist: [${Array.from(this.allowedHosts).join(', ')}]`,
      );
    }
  }

  /**
   * Returns the canonical host the signature should be bound to, given the
   * incoming request's Host header. Throws BadRequestException when the header
   * is missing, malformed, or not in the allowlist.
   *
   * The returned string is normalized (lowercase, trimmed) and never echoes
   * client-controlled formatting — the canonical value comes from the allowlist
   * entry that matched, so the byte sequence we verify against is fully
   * controlled by the server's configuration.
   */
  resolveExpectedHost(hostHeader: string | undefined): string {
    if (!hostHeader || typeof hostHeader !== 'string') {
      throw new BadRequestException('Missing Host header');
    }

    const normalized = hostHeader.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('Missing Host header');
    }

    if (!this.allowedHosts.has(normalized)) {
      throw new BadRequestException('Host not allowed for authentication');
    }

    return normalized;
  }

  /**
   * Exposed for tests and for the test-vector generator: the canonical
   * byte sequence the signature is verified against.
   */
  static buildChallengeMessage(host: string, nonce: Buffer): Buffer {
    const prefix = Buffer.from(`TilliT-Auth-Challenge-v1\n${host}\n`, 'utf8');
    return Buffer.concat([prefix, nonce]);
  }

  private loadAllowedHosts(): Set<string> {
    const raw = process.env.AUTH_ALLOWED_HOSTS;
    if (raw && raw.trim().length > 0) {
      return new Set(
        raw
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h.length > 0),
      );
    }

    const fromAppUrl = this.extractHostFromUrl(process.env.APP_URL);
    if (fromAppUrl) {
      return new Set([fromAppUrl]);
    }

    const fromDomain = process.env.DOMAIN?.trim().toLowerCase();
    if (fromDomain) {
      return new Set([fromDomain]);
    }

    return new Set<string>();
  }

  private extractHostFromUrl(url: string | undefined): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.host.toLowerCase() || null;
    } catch {
      return null;
    }
  }
}
