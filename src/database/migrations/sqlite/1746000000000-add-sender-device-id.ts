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
      `ALTER TABLE sender_key_distributions ADD COLUMN sender_device_id INTEGER NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite < 3.35 does not support DROP COLUMN. Rebuild the table.
    await queryRunner.query(`
      CREATE TABLE sender_key_distributions_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        sender_user_id INTEGER NOT NULL,
        distribution_id VARCHAR(36) NOT NULL,
        encrypted_sender_key TEXT NOT NULL,
        recipient_user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        delivered INTEGER DEFAULT 0 NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      INSERT INTO sender_key_distributions_old (
        id, room_id, sender_user_id, distribution_id, encrypted_sender_key,
        recipient_user_id, created_at, delivered
      )
      SELECT
        id, room_id, sender_user_id, distribution_id, encrypted_sender_key,
        recipient_user_id, created_at, delivered
      FROM sender_key_distributions
    `);

    await queryRunner.query(`DROP TABLE sender_key_distributions`);
    await queryRunner.query(
      `ALTER TABLE sender_key_distributions_old RENAME TO sender_key_distributions`,
    );

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_sender_key_room_recipient
      ON sender_key_distributions(room_id, recipient_user_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_sender_key_room_distribution
      ON sender_key_distributions(room_id, distribution_id)
    `);
  }
}
