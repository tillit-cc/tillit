import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MariadbConfigService {
  constructor(private configService: ConfigService) {}

  get host(): string {
    return this.configService.get<string>('mariadb.host') ?? 'localhost';
  }

  get port(): number {
    return Number(this.configService.get<number>('mariadb.port')) || 3306;
  }

  get database(): string {
    return this.configService.get<string>('mariadb.database') ?? '';
  }

  get user(): string {
    return this.configService.get<string>('mariadb.user') ?? 'root';
  }

  get password(): string {
    return this.configService.get<string>('mariadb.password') ?? '';
  }
}
