import {
  IsNumber,
  IsObject,
  IsOptional,
  IsArray,
  IsBoolean,
  IsString,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

export class RoomIdDto {
  @IsNumber()
  roomId: number;
}

export class SendMessageDto {
  @IsNumber()
  roomId: number;

  @IsObject()
  message: any;

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

export class SendPacketDto {
  @IsNumber()
  roomId: number;

  @IsObject()
  packet: any;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsNumber({}, { each: true })
  recipientIds?: number[];

  @IsOptional()
  @IsBoolean()
  volatile?: boolean;
}
