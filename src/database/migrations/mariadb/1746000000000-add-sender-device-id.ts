import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add nullable `sender_device_id` to `sender_key_distributions`.
 *
 * Backend forwards the sender's device id to the client so libsignal's
 * (senderId, deviceId) store key can disambiguate sender keys across
 * devices once multi-device is enabled (security audit finding H-04).
 *
 * Legacy rows stay NULL — the client falls back to deviceId=1, which
 * matches the single-device reality on the wire today.
 */
export class AddSenderDeviceId1746000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions ADD COLUMN sender_device_id INT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions DROP COLUMN sender_device_id`,
    );
  }
}
