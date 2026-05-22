import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite mirror of the multi-device fan-out column on
 * sender_key_distributions. See the MariaDB twin for rationale.
 */
export class AddRecipientDeviceId1747000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions ADD COLUMN recipient_device_id INTEGER NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_sender_key_recipient_device
         ON sender_key_distributions (recipient_user_id, recipient_device_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS IDX_sender_key_recipient_device`,
    );
    // SQLite supports DROP COLUMN from 3.35+. Skip the legacy rebuild; if the
    // runtime is older the migration will fail and the deploy is aborted.
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions DROP COLUMN recipient_device_id`,
    );
  }
}
