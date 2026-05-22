import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-device pairing scaffolding (wire v2 — see
 * `_shared/decisions/0003-pairing-direction-flip.md`).
 *
 *  - Extend `user_devices` with lifecycle metadata (status, device_name,
 *    user_agent, revoked_at). The existing `last_active_at` column doubles
 *    as `last_seen` — no new column to avoid churn.
 *  - Create `device_link_sessions` to track the linking handshake state.
 *    `primary_user_id`/`primary_device_id` are NULLable: the new device
 *    starts the session anonymously via `POST /link/init`; the primary
 *    only attaches itself at `/link/complete`.
 */
export class AddMultiDevicePairing1747000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE user_devices
        ADD COLUMN status ENUM('active','revoked','pending_link')
                  NOT NULL DEFAULT 'active',
        ADD COLUMN device_name VARCHAR(64) NULL,
        ADD COLUMN user_agent VARCHAR(256) NULL,
        ADD COLUMN revoked_at BIGINT NULL
    `);

    await queryRunner.query(
      `CREATE INDEX IDX_user_devices_user_status ON user_devices (user_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_link_sessions (
        id                          BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id                  CHAR(43) NOT NULL UNIQUE,
        primary_user_id             INT NULL,
        primary_device_id           INT NULL,
        ephemeral_public_key        VARCHAR(64) NOT NULL,
        device_name                 VARCHAR(64) NULL,
        user_agent                  VARCHAR(256) NULL,
        encrypted_payload           MEDIUMBLOB NULL,
        primary_ephemeral_pub_key   VARCHAR(64) NULL,
        assigned_device_id          INT NULL,
        status                      ENUM('waiting','pubkey-shared','completed','consumed','expired')
                                    NOT NULL DEFAULT 'waiting',
        created_at                  BIGINT NOT NULL,
        expires_at                  BIGINT NOT NULL,
        consumed_at                 BIGINT NULL,
        INDEX IDX_device_link_sessions_status (status, expires_at),
        INDEX IDX_device_link_sessions_expires (expires_at),
        CONSTRAINT FK_device_link_sessions_user
          FOREIGN KEY (primary_user_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS device_link_sessions`);
    await queryRunner.query(
      `DROP INDEX IDX_user_devices_user_status ON user_devices`,
    );
    await queryRunner.query(`
      ALTER TABLE user_devices
        DROP COLUMN status,
        DROP COLUMN device_name,
        DROP COLUMN user_agent,
        DROP COLUMN revoked_at
    `);
  }
}
