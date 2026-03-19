import { IsString, MaxLength } from 'class-validator';

/**
 * Request DTO for POST /auth/challenge
 */
export class ChallengeRequestDto {
  @IsString()
  @MaxLength(500)
  identityPublicKey: string; // Base64-encoded public identity key
}

/**
 * Response for POST /auth/challenge
 */
export interface ChallengeResponse {
  challengeId: string; // Unique challenge identifier
  nonce: string; // Base64-encoded nonce to sign
  expiresIn: number; // Seconds until challenge expires
}
