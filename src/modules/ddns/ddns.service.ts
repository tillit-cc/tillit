import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { CloudWorkerConfigService } from '../../config/cloud-worker/config.service';

@Injectable()
export class DdnsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DdnsService.name);
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private lastKnownIp: string | null = null;

  constructor(private readonly config: CloudWorkerConfigService) {}

  async onModuleInit() {
    if (!this.config.ddnsEnabled) {
      this.logger.log('DDNS is disabled');
      return;
    }

    this.logger.log('DDNS is enabled, starting periodic updates');
    await this.updateDns();
    this.startPeriodicUpdate();
  }

  onModuleDestroy() {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = null;
    }
  }

  async detectPublicIp(): Promise<string> {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ip: string };
    return data.ip;
  }

  async updateDns(): Promise<void> {
    try {
      const ip = await this.detectPublicIp();
      this.logger.log(`Public IP detected: ${ip}`);

      if (ip === this.lastKnownIp) {
        this.logger.log(`DDNS update: unchanged (IP: ${ip})`);
        return;
      }

      const res = await fetch(`${this.config.workerUrl}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boxId: this.config.cloudId,
          token: this.config.cloudToken,
          ip,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const data = (await res.json()) as {
        success?: boolean;
        action?: string;
        fqdn?: string;
        error?: string;
      };

      if (!res.ok || !data.success) {
        this.logger.error(
          `DDNS update failed: ${data.error || res.statusText}`,
        );
        return;
      }

      this.lastKnownIp = ip;
      this.logger.log(`DDNS update: ${data.action} ${data.fqdn} → ${ip}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`DDNS update failed: ${message}`);
    }
  }

  private startPeriodicUpdate() {
    this.intervalRef = setInterval(() => {
      void this.updateDns();
    }, this.config.ddnsUpdateInterval);
  }
}
