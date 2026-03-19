import type { Request } from 'express';

export type AuthenticatedRequest = Request & { user: { userId: number } };
