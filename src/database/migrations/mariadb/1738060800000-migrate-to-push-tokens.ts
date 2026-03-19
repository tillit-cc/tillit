import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateToPushTokens1738060800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create new push_tokens table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token      VARCHAR(255) NOT NULL UNIQUE,
        platform   ENUM('ios', 'android') NOT NULL,
        provider   ENUM('expo', 'firebase') NOT NULL DEFAULT 'expo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT FK_push_tokens_user
          FOREIGN KEY (user_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    // 2. Migrate data from token_firebase if it exists
    await queryRunner.query(`
      INSERT IGNORE INTO push_tokens (user_id, token, platform, provider, created_at)
      SELECT user_id, token, platform, 'firebase', created_at
      FROM token_firebase
    `);

    // 3. Drop old table
    await queryRunner.query(`DROP TABLE IF EXISTS token_firebase`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Recreate token_firebase table
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

    // 2. Migrate data back (only Firebase tokens)
    await queryRunner.query(`
      INSERT IGNORE INTO token_firebase (user_id, token, platform, created_at)
      SELECT user_id, token, platform, created_at
      FROM push_tokens
      WHERE provider = 'firebase'
    `);

    // 3. Drop push_tokens table
    await queryRunner.query(`DROP TABLE IF EXISTS push_tokens`);
  }
}
