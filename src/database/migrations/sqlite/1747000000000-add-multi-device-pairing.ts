import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SQLite mirror of the multi-device pairing scaffolding (wire v2 — see
 * `_shared/decisions/0003-pairing-direction-flip.md`).
 *
 * SQLite has no ENUM type — the `status` columns are TEXT with explicit
 * CHECK constraints. Timestamps use INTEGER (epoch milliseconds) for
 * symmetry with the rest of the SQLite schema.
 */
export class AddMultiDevicePairing1747000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','pending_link'))`,
    );
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN device_name VARCHAR(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN user_agent VARCHAR(256) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN revoked_at INTEGER NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_user_devices_user_status ON user_devices (user_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_link_sessions (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id                  VARCHAR(43) NOT NULL UNIQUE,
        primary_user_id             INTEGER NULL,
        primary_device_id           INTEGER NULL,
        ephemeral_public_key        VARCHAR(64) NOT NULL,
        device_name                 VARCHAR(64) NULL,
        user_agent                  VARCHAR(256) NULL,
        encrypted_payload           BLOB NULL,
        primary_ephemeral_pub_key   VARCHAR(64) NULL,
        assigned_device_id          INTEGER NULL,
        status                      TEXT NOT NULL DEFAULT 'waiting'
                                    CHECK (status IN ('waiting','pubkey-shared','completed','consumed','expired')),
        created_at                  INTEGER NOT NULL,
        expires_at                  INTEGER NOT NULL,
        consumed_at                 INTEGER NULL,
        FOREIGN KEY (primary_user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_device_link_sessions_status ON device_link_sessions (status, expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS IDX_device_link_sessions_expires ON device_link_sessions (expires_at)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS device_link_sessions`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS IDX_user_devices_user_status`,
    );

    // SQLite < 3.35: rebuild table to drop columns.
    await queryRunner.query(`
      CREATE TABLE user_devices_old (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id             INTEGER NOT NULL,
        device_id           INTEGER NOT NULL,
        registration_id     INTEGER NOT NULL,
        identity_public_key TEXT NOT NULL,
        name                VARCHAR(100),
        last_active_at      INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        created_at          INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        UNIQUE (user_id, device_id)
      )
    `);
    await queryRunner.query(`
      INSERT INTO user_devices_old (
        id, user_id, device_id, registration_id, identity_public_key,
        name, last_active_at, created_at
      )
      SELECT id, user_id, device_id, registration_id, identity_public_key,
             name, last_active_at, created_at
      FROM user_devices
    `);
    await queryRunner.query(`DROP TABLE user_devices`);
    await queryRunner.query(
      `ALTER TABLE user_devices_old RENAME TO user_devices`,
    );
  }
}
