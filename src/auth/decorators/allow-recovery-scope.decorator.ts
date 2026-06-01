import { SetMetadata } from '@nestjs/common';

/**
 * Marks a route handler (or controller) as accepting a recovery-scoped JWT
 * (`scope: 'recover'`, ADR-0010 OQ-1). Without this marker the default
 * JwtAuthGuard rejects recovery tokens with `RECOVERY_TOKEN_DENIED`.
 *
 * The recovery JWT is minted by `POST /auth/identity { recoverPrimary: true }`
 * after proving identity-key possession. It must remain confined to the single
 * downstream endpoint that rotates the device-auth key — every other route
 * (sockets included) must refuse it.
 */
export const ALLOW_RECOVERY_SCOPE_KEY = 'tillit:allowRecoveryScope';

export const AllowRecoveryScope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_RECOVERY_SCOPE_KEY, true);
