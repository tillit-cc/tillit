import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite mirror of the multi-device offline-queue column on
 * `pending_messages`. See the MariaDB twin for rationale.
 */
export class AddPendingMessageRecipientDeviceId1747000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE pending_messages ADD COLUMN recipient_device_id INTEGER NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_pending_messages_user_device_room
         ON pending_messages (user_id, recipient_device_id, room_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS IDX_pending_messages_user_device_room`,
    );
    // SQLite supports DROP COLUMN from 3.35+. Skip the legacy rebuild; if the
    // runtime is older the migration will fail and the deploy is aborted.
    await queryRunner.query(
      `ALTER TABLE pending_messages DROP COLUMN recipient_device_id`,
    );
  }
}
