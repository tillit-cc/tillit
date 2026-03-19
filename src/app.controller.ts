import {
  Controller,
  Get,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AppService, HealthStatus } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth(): Promise<HealthStatus> {
    return this.appService.checkHealth();
  }

  /**
   * Caddy on-demand TLS validation endpoint
   *
   * Caddy calls this endpoint to check if a certificate should be issued
   * for a given domain. We only allow certificates for our configured domain.
   *
   * @see https://caddyserver.com/docs/automatic-https#on-demand-tls
   */
  @Get('caddy/ask')
  validateCaddyDomain(@Query('domain') domain: string): { ok: boolean } {
    const configuredDomain = process.env.DOMAIN;

    // If no domain is configured, deny all certificate requests
    if (!configuredDomain) {
      throw new HttpException('No domain configured', HttpStatus.FORBIDDEN);
    }

    // Only allow certificate for our configured domain
    if (domain === configuredDomain) {
      return { ok: true };
    }

    // Deny certificates for any other domain
    throw new HttpException('Domain not allowed', HttpStatus.FORBIDDEN);
  }
}
