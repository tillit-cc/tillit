import { IsString, IsNumber, MaxLength } from 'class-validator';

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
}

export interface IdentityAuthResponse {
  accessToken: string;
  userId: number;
  isNewUser: boolean;
  banned?: boolean;
}
