import {
  IsString,
  IsNumber,
  IsArray,
  IsBoolean,
  ValidateNested,
  IsOptional,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class KeyDto {
  @IsNumber()
  keyId: number;

  @IsString()
  @MaxLength(10000)
  keyData: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  signature?: string;
}

export class SignedKeyDto extends KeyDto {
  @IsString()
  @MaxLength(10000)
  signature: string;
}

export class UploadKeysDto {
  @IsNumber()
  deviceId: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  identityPublicKey?: string;

  @IsOptional()
  @IsNumber()
  registrationId?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => SignedKeyDto)
  signedPreKey?: SignedKeyDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => KeyDto)
  preKeys?: KeyDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => KeyDto)
  kyberPreKeys?: KeyDto[];

  // Per-device server-auth (ADR-0010): libsignal Curve25519 public key bound to
  // (userId, deviceId). TOFU on first upload; immutable thereafter.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deviceAuthPublicKey?: string;

  // Primary recovery (deviceId=1 only): re-bind the device-auth key and revoke
  // all linked devices. See ADR-0010 OQ-1.
  @IsOptional()
  @IsBoolean()
  recoverPrimary?: boolean;
}

export class KeyStatusDto {
  preKeysCount: number;
  kyberPreKeysCount: number;
  deviceIds: string[];
  identityKeyPresent: boolean;
  signedPreKeyPresent: boolean;
}
