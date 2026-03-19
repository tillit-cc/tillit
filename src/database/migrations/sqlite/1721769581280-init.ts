import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialTillitSchema1721769581280 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_public_key VARCHAR(500) NOT NULL UNIQUE,
        registration_id     INTEGER NOT NULL,
        created_at          INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        updated_at          INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL
      )
    `);

    // Trigger for updated_at on users
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS users_updated_at
      AFTER UPDATE ON users
      FOR EACH ROW
      BEGIN
        UPDATE users SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
      END
    `);

    // 2. rooms
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        invite_code  VARCHAR(20) UNIQUE NOT NULL,
        name         VARCHAR(255),
        status       INTEGER DEFAULT 0 NOT NULL,
        id_user      INTEGER NOT NULL,
        use_sender_keys INTEGER DEFAULT 0 NOT NULL,
        created_at   INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        updated_at   INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (id_user) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Trigger for updated_at on rooms
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS rooms_updated_at
      AFTER UPDATE ON rooms
      FOR EACH ROW
      BEGIN
        UPDATE rooms SET updated_at = strftime('%s', 'now') WHERE id = NEW.id;
      END
    `);

    // 3. room_users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_users (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id   INTEGER NOT NULL,
        user_id   INTEGER NOT NULL,
        username  TEXT NULL,
        joined_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 4. sender_key_distributions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sender_key_distributions (
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

    // Indexes for sender_key_distributions
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_sender_key_room_recipient
      ON sender_key_distributions(room_id, recipient_user_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_sender_key_room_distribution
      ON sender_key_distributions(room_id, distribution_id)
    `);

    // 5. sender_key_metadata
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sender_key_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL,
        distribution_id VARCHAR(36) NOT NULL,
        sender_user_id INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        rotated_at INTEGER,
        active INTEGER DEFAULT 1 NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(room_id, sender_user_id, distribution_id)
      )
    `);

    // Index for sender_key_metadata
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_sender_meta_room_active
      ON sender_key_metadata(room_id, sender_user_id, active)
    `);

    // 6. pending_messages (offline message queue)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pending_messages (
        id         VARCHAR(36) PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        room_id    INTEGER NOT NULL,
        envelope   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts   INTEGER DEFAULT 0 NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE
      )
    `);

    // Indexes for pending_messages
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_pending_messages_user_room
      ON pending_messages (user_id, room_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_pending_messages_expires
      ON pending_messages (expires_at)
    `);

    // 5. user_devices
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_devices (
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

    // Trigger for last_active_at on user_devices
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS user_devices_last_active_at
      AFTER UPDATE ON user_devices
      FOR EACH ROW
      BEGIN
        UPDATE user_devices SET last_active_at = strftime('%s', 'now') WHERE id = NEW.id;
      END
    `);

    // 6. token_firebase
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS token_firebase (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        token      VARCHAR(255) NOT NULL UNIQUE,
        platform   TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        created_at INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 7. signal_key_types
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS signal_key_types (
        id   INTEGER PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL
      )
    `);

    await queryRunner.query(`
      INSERT OR IGNORE INTO signal_key_types (id, code, name) VALUES
        (1, 'preKey', 'Pre Key'),
        (2, 'kyberPreKey', 'Kyber Pre Key'),
        (3, 'signedPreKey', 'Signed Pre Key')
    `);

    // 8. signal_keys
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS signal_keys (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        device_id  VARCHAR(100) NOT NULL,
        key_type   INTEGER NOT NULL,
        key_id     INTEGER NOT NULL,
        key_data   TEXT NOT NULL,
        key_signature TEXT NULL,
        consumed   INTEGER DEFAULT 0 NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (key_type) REFERENCES signal_key_types (id) ON DELETE RESTRICT
      )
    `);

    // Index for signal_keys
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_signal_keys_user_device_type
      ON signal_keys (user_id, device_id, key_type)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers first
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS user_devices_last_active_at;`,
    );
    await queryRunner.query(`DROP TRIGGER IF EXISTS rooms_updated_at;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS users_updated_at;`);

    // Drop Tillit tables in reverse order:
    await queryRunner.query(`DROP TABLE IF EXISTS signal_keys;`);
    await queryRunner.query(`DROP TABLE IF EXISTS signal_key_types;`);
    await queryRunner.query(`DROP TABLE IF EXISTS token_firebase;`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_devices;`);
    await queryRunner.query(`DROP TABLE IF EXISTS pending_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sender_key_metadata;`);
    await queryRunner.query(`DROP TABLE IF EXISTS sender_key_distributions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS room_users;`);
    await queryRunner.query(`DROP TABLE IF EXISTS rooms;`);
    await queryRunner.query(`DROP TABLE IF EXISTS users;`);
  }
}
