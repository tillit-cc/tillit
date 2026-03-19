import { Injectable, Logger } from '@nestjs/common';
import { CloudWorkerConfigService } from '../config/cloud-worker/config.service';

interface PushTokenWithLang {
  token: string;
  lang: string;
}

@Injectable()
export class PushRelayService {
  private readonly logger = new Logger(PushRelayService.name);

  constructor(private readonly config: CloudWorkerConfigService) {
    if (this.isConfigured()) {
      this.logger.log('Push relay configured via cloud worker');
    } else {
      this.logger.warn(
        'Push relay not configured (missing CLOUD_WORKER_URL, CLOUD_ID, or CLOUD_TOKEN)',
      );
    }
  }

  /**
   * Check if push relay is properly configured
   */
  isConfigured(): boolean {
    return !!(
      this.config.workerUrl &&
      this.config.cloudId &&
      this.config.cloudToken
    );
  }

  /**
   * Send push notifications via the cloud worker relay.
   * Groups tokens by language and sends one request per group.
   * Best-effort: catches all errors, never throws.
   */
  async sendNotification(
    tokens: PushTokenWithLang[],
    data?: {
      roomId?: string;
      messageId?: string;
      senderId?: string;
    },
  ): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Push relay not configured, skipping notification');
      return;
    }

    if (!tokens || tokens.length === 0) {
      return;
    }

    // Group tokens by language
    const byLang = new Map<string, string[]>();
    for (const { token, lang } of tokens) {
      const key = lang || 'en';
      if (!byLang.has(key)) {
        byLang.set(key, []);
      }
      byLang.get(key)!.push(token);
    }

    for (const [lang, langTokens] of byLang) {
      try {
        const body: Record<string, unknown> = {
          boxId: this.config.cloudId,
          token: this.config.cloudToken,
          to: langTokens,
          lang,
        };

        if (data) {
          body.data = data;
        }

        const res = await fetch(`${this.config.workerUrl}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });

        const result = (await res.json()) as {
          success?: boolean;
          sent?: number;
          failed?: number;
          error?: string;
        };

        if (!res.ok || !result.success) {
          this.logger.error(
            `Push relay failed for lang=${lang}: ${result.error || res.statusText}`,
          );
        } else {
          this.logger.log(
            `Push relay sent=${result.sent} failed=${result.failed} lang=${lang}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.error(`Push relay error for lang=${lang}: ${message}`);
      }
    }
  }
}
