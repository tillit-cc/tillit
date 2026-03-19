import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialTillitSchema1721769581280 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        identity_public_key VARCHAR(500) NOT NULL UNIQUE,
        registration_id     INT NOT NULL,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    // 2. rooms
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        invite_code  VARCHAR(20) UNIQUE NOT NULL,
        name         VARCHAR(255),
        status       TINYINT DEFAULT 0 NOT NULL,
        id_user      INT NOT NULL,
        use_sender_keys TINYINT DEFAULT 0 NOT NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_rooms_user
          FOREIGN KEY (id_user) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 3. room_users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS room_users (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        room_id   INT NOT NULL,
        user_id   INT NOT NULL,
        username  VARCHAR(100) NULL,
        joined_at BIGINT NOT NULL,
        CONSTRAINT FK_room_users_room
          FOREIGN KEY (room_id) REFERENCES rooms (id)
            ON DELETE CASCADE,
        CONSTRAINT FK_room_users_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 4. sender_key_distributions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sender_key_distributions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        sender_user_id INT NOT NULL,
        distribution_id VARCHAR(36) NOT NULL,
        encrypted_sender_key TEXT NOT NULL,
        recipient_user_id INT NOT NULL,
        created_at BIGINT NOT NULL,
        delivered TINYINT DEFAULT 0 NOT NULL,
        INDEX IDX_sender_key_room_recipient (room_id, recipient_user_id),
        INDEX IDX_sender_key_room_distribution (room_id, distribution_id),
        CONSTRAINT FK_sender_key_room
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        CONSTRAINT FK_sender_key_sender
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT FK_sender_key_recipient
          FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 5. sender_key_metadata
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sender_key_metadata (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        distribution_id VARCHAR(36) NOT NULL,
        sender_user_id INT NOT NULL,
        created_by INT NOT NULL,
        created_at BIGINT NOT NULL,
        rotated_at BIGINT NULL,
        active TINYINT DEFAULT 1 NOT NULL,
        INDEX IDX_sender_meta_room_active (room_id, sender_user_id, active),
        UNIQUE KEY UNQ_room_sender_distribution (room_id, sender_user_id, distribution_id),
        CONSTRAINT FK_sender_meta_room
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        CONSTRAINT FK_sender_meta_sender
          FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT FK_sender_meta_creator
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 6. pending_messages (offline message queue)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pending_messages (
        id         VARCHAR(36) PRIMARY KEY,
        user_id    INT NOT NULL,
        room_id    INT NOT NULL,
        envelope   TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts   INT DEFAULT 0 NOT NULL,
        INDEX IDX_pending_messages_user_room (user_id, room_id),
        INDEX IDX_pending_messages_expires (expires_at),
        CONSTRAINT FK_pending_messages_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE,
        CONSTRAINT FK_pending_messages_room
          FOREIGN KEY (room_id) REFERENCES rooms (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 5. user_devices
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS user_devices (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        user_id             INT NOT NULL,
        device_id           INT NOT NULL,
        registration_id     INT NOT NULL,
        identity_public_key TEXT NOT NULL,
        name                VARCHAR(100),
        last_active_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL ON UPDATE CURRENT_TIMESTAMP,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        UNIQUE KEY unique_user_device (user_id, device_id),
        CONSTRAINT FK_user_devices_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 6. token_firebase
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS token_firebase (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token      VARCHAR(255) NOT NULL UNIQUE,
        platform   ENUM('ios', 'android') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT FK_token_firebase_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 7. signal_key_types
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS signal_key_types (
        id   INT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB
    `);

    await queryRunner.query(`
      INSERT IGNORE INTO signal_key_types (id, code, name) VALUES
        (1, 'preKey', 'Pre Key'),
        (2, 'kyberPreKey', 'Kyber Pre Key'),
        (3, 'signedPreKey', 'Signed Pre Key')
    `);

    // 8. signal_keys
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS signal_keys (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        device_id  VARCHAR(100) NOT NULL,
        key_type   INT NOT NULL,
        key_id     INT NOT NULL,
        key_data   TEXT NOT NULL,
        key_signature TEXT NULL,
        consumed   TINYINT DEFAULT 0 NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        INDEX IDX_signal_keys_user_device_type (user_id, device_id, key_type),
        CONSTRAINT FK_signal_keys_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE,
        CONSTRAINT FK_signal_keys_type
          FOREIGN KEY (key_type) REFERENCES signal_key_types (id)
            ON DELETE RESTRICT
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
