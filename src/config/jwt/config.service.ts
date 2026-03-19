import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type JwtExpiresIn = string | number;

@Injectable()
export class JwtConfigService {
  constructor(private configService: ConfigService) {}

  get algorithm(): string {
    return this.configService.get<string>('jwt.algorithm') ?? 'RS256';
  }

  get publicKey(): string {
    return this.configService.get<string>('jwt.publicKey') ?? '';
  }

  get privateKey(): string {
    return this.configService.get<string>('jwt.privateKey') ?? '';
  }

  get expiresIn(): JwtExpiresIn {
    return this.configService.get<string>('jwt.expiresIn') ?? '7d';
  }

  get publicKeyPath(): string {
    return (
      this.configService.get<string>('jwt.publicKeyPath') ?? './keys/public.pem'
    );
  }

  get privateKeyPath(): string {
    return (
      this.configService.get<string>('jwt.privateKeyPath') ??
      './keys/private.pem'
    );
  }
}
