import { IsString, IsNumber, MaxLength, IsOptional } from 'class-validator';

export class IdentityAuthDto {
  @IsString()
  @MaxLength(500)
  identityPublicKey: string; // Base64-encoded public identity key

  @IsNumber()
  registrationId: number; // Signal Protocol registration ID

  @IsNumber()
  deviceId: number; // Device ID for Signal Protocol

  @IsString()
  @MaxLength(500)
  signedPreKeyPublicKey: string; // Base64-encoded signed pre-key

  @IsNumber()
  signedPreKeyId: number; // Signed pre-key ID

  @IsString()
  @MaxLength(500)
  signedPreKeySignature: string; // Base64-encoded signature of signed pre-key

  // Challenge-response fields for proof of private key possession
  @IsString()
  @MaxLength(500)
  challengeId: string; // Challenge ID from POST /auth/challenge

  @IsString()
  @MaxLength(500)
  challengeSignature: string; // Base64-encoded Ed25519 signature of the nonce

  // Per-device server-auth (ADR-0010): signature of the SAME domain-separated
  // challenge message, produced with the device-auth private key. Optional in
  // transition mode; required once the device has a registered auth key.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deviceAuthSignature?: string;
}

export interface IdentityAuthResponse {
  accessToken: string;
  userId: number;
  isNewUser: boolean;
  banned?: boolean;
}
