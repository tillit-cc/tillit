import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { PushToken } from '../entities/push-token.entity';

@Injectable()
export class ExpoNotificationService {
  private readonly logger = new Logger(ExpoNotificationService.name);
  private readonly expo: Expo;

  constructor(
    @InjectRepository(PushToken)
    private readonly pushTokenRepository: Repository<PushToken>,
  ) {
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    this.expo = new Expo({
      accessToken: accessToken || undefined,
    });

    if (accessToken) {
      this.logger.log('Expo SDK initialized with access token');
    } else {
      this.logger.warn('Expo SDK initialized without access token');
    }
  }

  /**
   * Send push notification to multiple devices
   * @param tokens - Array of Expo Push Tokens
   * @param payload - Notification payload
   */
  async sendNotification(
    tokens: string[],
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
    },
  ): Promise<void> {
    if (!tokens || tokens.length === 0) {
      this.logger.debug('No tokens provided. Notification not sent.');
      return;
    }

    // Filter valid Expo tokens
    const validTokens = tokens.filter((token) => {
      const isValid = Expo.isExpoPushToken(token);
      if (!isValid) {
        this.logger.warn(`Invalid Expo push token format: ${String(token)}`);
      }
      return isValid;
    });

    if (validTokens.length === 0) {
      this.logger.warn('No valid Expo push tokens. Notification not sent.');
      return;
    }

    // Build messages
    const messages: ExpoPushMessage[] = validTokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      sound: process.env.PUSH_NOTIFICATION_SOUND || 'default',
      priority: 'high',
    }));

    // Chunk messages (Expo recommends max 100 per request)
    const chunks = this.expo.chunkPushNotifications(messages);

    let successCount = 0;
    let failureCount = 0;

    for (const chunk of chunks) {
      try {
        const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk);

        ticketChunk.forEach((ticket: ExpoPushTicket, index: number) => {
          if (ticket.status === 'ok') {
            successCount++;
          } else {
            failureCount++;
            const token = String(chunk[index].to);
            this.logger.warn(
              `Failed to send to ${token}: ${ticket.message} (${ticket.details?.error || 'unknown'})`,
            );

            // Handle DeviceNotRegistered - remove stale token from DB
            if (ticket.details?.error === 'DeviceNotRegistered') {
              this.logger.warn(
                `Token ${token} is no longer registered. Removing from DB.`,
              );
              this.pushTokenRepository
                .delete({ token })
                .catch((err) =>
                  this.logger.error(
                    `Failed to delete stale push token ${token}:`,
                    err,
                  ),
                );
            }
          }
        });
      } catch (error) {
        this.logger.error('Error sending push notification chunk:', error);
        failureCount += chunk.length;
      }
    }

    this.logger.log(
      `Expo notifications sent: ${successCount} success, ${failureCount} failure`,
    );
  }

  /**
   * Send notification to a single device
   * @param token - Expo Push Token
   * @param payload - Notification payload
   */
  async sendNotificationToDevice(
    token: string,
    payload: {
      title: string;
      body: string;
      data?: Record<string, string>;
    },
  ): Promise<void> {
    await this.sendNotification([token], payload);
  }
}
