import {
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsOptional,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class InitializeSenderKeysDto {
  @IsNumber()
  roomId: number;
}

class SenderKeyDistributionItem {
  @IsNumber()
  recipientUserId: number;

  // Optional for backward compat — legacy single-device clients omit it.
  // Once multi-device clients are everywhere, callers must set it explicitly
  // so the primary can distribute one row per (recipientUser, recipientDevice).
  @IsOptional()
  @IsNumber()
  recipientDeviceId?: number;

  @IsString()
  @MaxLength(10000)
  encryptedSenderKey: string;
}

export class DistributeSenderKeyDto {
  @IsString()
  @MaxLength(36)
  distributionId: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SenderKeyDistributionItem)
  distributions: SenderKeyDistributionItem[];
}

export class MarkDeliveredDto {
  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMaxSize(100)
  distributionIds: number[];
}
