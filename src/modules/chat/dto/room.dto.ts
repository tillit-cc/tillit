import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class CreateRoomDto {
  @IsString()
  @IsOptional()
  @MaxLength(30)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  username?: string;

  @IsBoolean()
  @IsOptional()
  administered?: boolean;
}

export class JoinRoomDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  username?: string;
}

export class UpdateRoomDto {
  @IsString()
  @IsOptional()
  @MaxLength(30)
  name?: string;
}

export class UpdateUsernameDto {
  @IsString()
  @MaxLength(100)
  username: string;
}

export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  username?: string;

  // Future profile fields can be added here
}
