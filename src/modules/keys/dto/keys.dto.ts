import {
  IsString,
  IsNumber,
  IsArray,
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
}

export class KeyStatusDto {
  preKeysCount: number;
  kyberPreKeysCount: number;
  deviceIds: string[];
  identityKeyPresent: boolean;
  signedPreKeyPresent: boolean;
}
