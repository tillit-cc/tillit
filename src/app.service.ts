import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
// Track application start time for uptime calculation
const startTime = Date.now();

// Read version from package.json at startup (works in all environments)
let appVersion = '0.0.0';
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
  );
  appVersion = pkg.version;
} catch {
  // fallback if package.json not found
}

export interface HealthStatus {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  error?: string;
}

@Injectable()
export class AppService {
  constructor(private readonly dataSource: DataSource) {}

  getHello(): string {
    return 'Hello World!';
  }

  async checkHealth(): Promise<HealthStatus> {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const version = appVersion;

    try {
      // Simple database connectivity check
      await this.dataSource.query('SELECT 1');

      return {
        status: 'ok',
        version,
        uptime: uptimeSeconds,
      };
    } catch (error) {
      return {
        status: 'error',
        version,
        uptime: uptimeSeconds,
        error:
          process.env.NODE_ENV === 'production'
            ? 'Database check failed'
            : error instanceof Error
              ? error.message
              : 'Database check failed',
      };
    }
  }
}
