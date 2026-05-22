import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-device fan-out for sender keys.
 *
 * `sender_key_distributions` previously assumed one recipient row per
 * (room, sender, recipientUser) tuple — implicit deviceId = 1. Once the
 * recipient can have N devices, the primary distributes one row per
 * (recipientUser, recipientDevice).
 *
 * Column is nullable so legacy rows keep working (the client falls back
 * to deviceId=1, matching the single-device reality on the wire today).
 */
export class AddRecipientDeviceId1747000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions ADD COLUMN recipient_device_id INT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_sender_key_recipient_device
         ON sender_key_distributions (recipient_user_id, recipient_device_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IDX_sender_key_recipient_device ON sender_key_distributions`,
    );
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions DROP COLUMN recipient_device_id`,
    );
  }
}
