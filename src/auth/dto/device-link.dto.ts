import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `POST /auth/devices/link/init`. Anonymous (no JWT) — the new
 * device kicks off the pairing session by uploading its ephemeral
 * X25519 public key plus optional UA metadata.
 */
export class InitLinkDto {
  @IsString()
  @MaxLength(64)
  ephemeralPublicKey: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  userAgent?: string;
}

/**
 * Body of `POST /auth/devices/link/share-pubkey`. Authenticated as primary.
 * The primary scans the QR (which carries `sessionId` + `E_pub`) and shares
 * its ephemeral `P_pub` ahead of `/complete`, so the new device can compute
 * its own safety number before the primary commits the encrypted payload.
 * See ADR-0004 (`_shared/decisions/0004-symmetric-safety-number.md`).
 */
export class SharePubkeyDto {
  @IsString()
  @MaxLength(64)
  @MinLength(8)
  sessionId: string;

  @IsString()
  @MaxLength(64)
  primaryEphemeralPublicKey: string;
}

/**
 * Body of `POST /auth/devices/link/complete` (wire v2.1). Authenticated as
 * primary. The primary deposits the encrypted identity payload after the
 * symmetric safety-number check passes. `primaryEphemeralPublicKey` was
 * already deposited via `/share-pubkey` so it is no longer in this body.
 */
export class CompleteLinkDto {
  @IsString()
  @MaxLength(64)
  @MinLength(8)
  sessionId: string;

  // base64 of `[1B v][12B iv][N B ct][16B tag]`. Hard cap at 4 KB (spec).
  @IsString()
  @MaxLength(8192)
  encryptedPayload: string;
}

export interface DeviceSummaryDto {
  deviceId: number;
  deviceName: string;
  status: 'active' | 'pending_link' | 'revoked';
  isPrimary: boolean;
  isCurrent: boolean;
  createdAt: string;
  lastSeen: string | null;
  userAgent: string | null;
}

export interface LinkInitResponse {
  sessionId: string;
  expiresAt: string;
}

export interface LinkResultResponse {
  status: 'pending' | 'pubkey-shared' | 'completed' | 'expired';
  // Present from `pubkey-shared` onwards.
  primaryEphemeralPublicKey?: string;
  primaryUserId?: number;
  identityKeyPub?: string;
  // Present only when `completed`.
  assignedDeviceId?: number;
  encryptedPayload?: string;
}

export interface LinkSharePubkeyResponse {
  ok: true;
}

export interface LinkCompleteResponse {
  assignedDeviceId: number;
  expiresAt: string;
}

export interface DeviceRevokeResponse {
  deviceId: number;
  status: 'revoked';
  revokedAt: string;
}

export interface DeviceListResponse {
  devices: DeviceSummaryDto[];
}

// JWT field name kept in sync with what we expose on requests.
export const PRIMARY_DEVICE_ID = 1;

// 5 active devices per user (active + pending_link). Configurable via env.
export const DEFAULT_DEVICE_CAP = 5;

// Soft cap on globally-open `waiting` sessions across all users. Protects
// the anonymous `/link/init` endpoint from flooding. Configurable via env.
export const DEFAULT_OPEN_SESSION_CAP = 1000;

// Session TTL after creation (claim window) and after complete (result window).
export const DEFAULT_LINK_TTL_MS = 5 * 60 * 1000;
