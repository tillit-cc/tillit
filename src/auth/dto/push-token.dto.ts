import { IsString, IsEnum, IsOptional, MaxLength } from 'class-validator';
import { Platform, PushProvider } from '../../entities/push-token.entity';

export class RegisterPushTokenDto {
  @IsString()
  @MaxLength(500)
  token: string;

  @IsEnum(Platform)
  platform: Platform;

  @IsOptional()
  @IsEnum(PushProvider)
  provider?: PushProvider = PushProvider.EXPO;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  lang?: string;
}
