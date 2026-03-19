import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CloudWorkerConfigService {
  constructor(private configService: ConfigService) {}

  get workerUrl(): string {
    return this.configService.get<string>('cloudWorker.workerUrl') ?? '';
  }

  get cloudId(): string {
    return this.configService.get<string>('cloudWorker.cloudId') ?? '';
  }

  get cloudToken(): string {
    return this.configService.get<string>('cloudWorker.cloudToken') ?? '';
  }

  get ddnsEnabled(): boolean {
    return this.configService.get<string>('cloudWorker.ddnsEnabled') === 'true';
  }

  get ddnsUpdateInterval(): number {
    return (
      Number(
        this.configService.get<number>('cloudWorker.ddnsUpdateInterval'),
      ) || 300000
    );
  }

  get pushIncludeData(): boolean {
    return (
      this.configService.get<string>('cloudWorker.pushIncludeData', 'false') ===
      'true'
    );
  }
}
