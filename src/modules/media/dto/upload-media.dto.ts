import {
  IsNumber,
  IsString,
  IsBoolean,
  IsOptional,
  Matches,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

const MIME_PATTERN = /^(application|image|audio|video|text)\/[a-zA-Z0-9.+-]+$/;

export class UploadMediaDto {
  @IsNumber()
  roomId: number;

  @IsString()
  @MaxLength(14680064) // ~14MB base64 (aligned with 10MB binary + base64 overhead)
  data: string; // Base64 encoded encrypted data

  @IsString()
  @Matches(MIME_PATTERN, { message: 'Invalid mimeType format' })
  mimeType: string;

  @IsOptional()
  @IsBoolean()
  ephemeral?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(parseInt(process.env.EPHEMERAL_MEDIA_MAX_TTL_HOURS || '168', 10))
  ttlHours?: number;
}
