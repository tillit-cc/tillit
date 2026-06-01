import type { Request } from 'express';

export type JwtScope = 'recover';

export const RECOVERY_SCOPE: JwtScope = 'recover';

export type AuthenticatedRequest = Request & {
  user: { userId: number; deviceId: number; scope?: JwtScope };
};
