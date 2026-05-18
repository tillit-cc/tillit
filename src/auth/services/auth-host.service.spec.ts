import { BadRequestException } from '@nestjs/common';
import { AuthHostService } from './auth-host.service';

describe('AuthHostService', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('resolveExpectedHost', () => {
    it('returns the normalized host when it matches the allowlist', () => {
      process.env.AUTH_ALLOWED_HOSTS = 'api.tillit.cc, abcdef.onion';
      const svc = new AuthHostService();

      expect(svc.resolveExpectedHost('API.tillit.cc')).toBe('api.tillit.cc');
      expect(svc.resolveExpectedHost('abcdef.onion')).toBe('abcdef.onion');
    });

    it('rejects a host that is not in the allowlist', () => {
      process.env.AUTH_ALLOWED_HOSTS = 'api.tillit.cc';
      const svc = new AuthHostService();

      expect(() => svc.resolveExpectedHost('evil.example.com')).toThrow(
        BadRequestException,
      );
    });

    it('rejects a missing or empty Host header', () => {
      process.env.AUTH_ALLOWED_HOSTS = 'api.tillit.cc';
      const svc = new AuthHostService();

      expect(() => svc.resolveExpectedHost(undefined)).toThrow(
        BadRequestException,
      );
      expect(() => svc.resolveExpectedHost('')).toThrow(BadRequestException);
      expect(() => svc.resolveExpectedHost('   ')).toThrow(BadRequestException);
    });

    it('falls back to APP_URL host when AUTH_ALLOWED_HOSTS is unset', () => {
      delete process.env.AUTH_ALLOWED_HOSTS;
      process.env.APP_URL = 'https://api.tillit.cc';
      const svc = new AuthHostService();

      expect(svc.resolveExpectedHost('api.tillit.cc')).toBe('api.tillit.cc');
      expect(() => svc.resolveExpectedHost('other.host')).toThrow(
        BadRequestException,
      );
    });

    it('falls back to DOMAIN when APP_URL is unset', () => {
      delete process.env.AUTH_ALLOWED_HOSTS;
      delete process.env.APP_URL;
      process.env.DOMAIN = 'mybox.tillit.cc';
      const svc = new AuthHostService();

      expect(svc.resolveExpectedHost('mybox.tillit.cc')).toBe(
        'mybox.tillit.cc',
      );
    });

    it('rejects every request when no host is configured', () => {
      delete process.env.AUTH_ALLOWED_HOSTS;
      delete process.env.APP_URL;
      delete process.env.DOMAIN;
      const svc = new AuthHostService();

      expect(() => svc.resolveExpectedHost('anything.example.com')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('buildChallengeMessage', () => {
    it('prepends the v1 domain separator and the host to the nonce', () => {
      const nonce = Buffer.from('hello', 'utf8');
      const out = AuthHostService.buildChallengeMessage('api.tillit.cc', nonce);

      expect(out.toString('utf8')).toBe(
        'TilliT-Auth-Challenge-v1\napi.tillit.cc\nhello',
      );
    });

    it('uses a single ASCII newline (0x0A) as the separator', () => {
      const nonce = Buffer.alloc(0);
      const out = AuthHostService.buildChallengeMessage('h', nonce);

      const newlines = Array.from(out).filter((b) => b === 0x0a).length;
      expect(newlines).toBe(2);
    });

    it('binds the signature to a different host', () => {
      const nonce = Buffer.from([1, 2, 3, 4]);
      const a = AuthHostService.buildChallengeMessage('a.tillit.cc', nonce);
      const b = AuthHostService.buildChallengeMessage('b.tillit.cc', nonce);

      expect(a.equals(b)).toBe(false);
    });
  });
});
