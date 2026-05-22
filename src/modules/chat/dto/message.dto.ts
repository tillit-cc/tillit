import {
  IsNumber,
  IsObject,
  IsOptional,
  IsArray,
  IsBoolean,
  IsString,
  IsUUID,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RoomIdDto {
  @IsNumber()
  roomId: number;
}

export class FanoutRecipientDto {
  @IsNumber()
  userId: number;

  @IsNumber()
  deviceId: number;

  @IsString()
  ciphertext: string;
}

export class SendMessageMetadataDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id_parent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  version?: string;
}

export class SendMessageDto {
  @IsNumber()
  roomId: number;

  // backend-0016: optional client-minted UUID propagated to the envelope id
  // for every recipient. Lets the sender match incoming delivered/read
  // receipts (which carry id_message = envelope.id) against the optimistic
  // row it stored locally. Falls back to a server-minted uuidv4 when absent
  // (legacy clients keep working — they just won't get receipt-driven
  // status updates until they upgrade).
  @IsOptional()
  @IsUUID()
  id?: string;

  // Legacy single-ciphertext path. Either this OR `recipients[]` must be set.
  // When `recipients[]` is set, the server fans out one envelope per
  // (recipientUser, recipientDevice) socket so each linked device receives
  // a ciphertext encrypted specifically for it.
  @IsOptional()
  @IsObject()
  message?: any;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FanoutRecipientDto)
  recipients?: FanoutRecipientDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SendMessageMetadataDto)
  metadata?: SendMessageMetadataDto;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @IsOptional()
  @IsBoolean()
  volatile?: boolean;
}

export class FanoutPacketRecipientDto {
  @IsNumber()
  userId: number;

  @IsNumber()
  deviceId: number;

  @IsObject()
  packet: any;
}

export class SendPacketDto {
  @IsNumber()
  roomId: number;

  // Legacy single-packet path. Either this OR `recipients[]` must be set.
  // The legacy path broadcasts the same packet to all `recipientIds` (or
  // every room member) without per-device addressing — fine for control
  // packets meant for the whole user (e.g. presence). Per-device control
  // packets (X3DH session establishment, etc.) must use `recipients[]`.
  @IsOptional()
  @IsObject()
  packet?: any;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsNumber({}, { each: true })
  recipientIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FanoutPacketRecipientDto)
  recipients?: FanoutPacketRecipientDto[];

  @IsOptional()
  @IsBoolean()
  volatile?: boolean;
}
