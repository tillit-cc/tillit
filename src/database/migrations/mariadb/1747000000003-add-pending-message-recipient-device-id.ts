import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-device offline queue.
 *
 * Before this migration `pending_messages` was keyed on `(user_id, room_id)`,
 * so when two devices of the same user fan-out to each other the offline
 * recipient's ciphertext could be drained by whichever device reconnects
 * first — the row was indistinguishable.
 *
 * Nullable so v0.x rows (and the legacy single-recipient path) keep working;
 * the service falls back to "any device of this user" when the column is NULL.
 */
export class AddPendingMessageRecipientDeviceId1747000000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE pending_messages ADD COLUMN recipient_device_id INT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_pending_messages_user_device_room
         ON pending_messages (user_id, recipient_device_id, room_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IDX_pending_messages_user_device_room ON pending_messages`,
    );
    await queryRunner.query(
      `ALTER TABLE pending_messages DROP COLUMN recipient_device_id`,
    );
  }
}
