import { MigrationInterface, QueryRunner } from 'typeorm';

export class MigrateToPushTokens1738060800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create new push_tokens table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        token      VARCHAR(255) NOT NULL UNIQUE,
        platform   TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        provider   TEXT NOT NULL DEFAULT 'expo' CHECK(provider IN ('expo', 'firebase')),
        created_at INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 2. Migrate data from token_firebase if it exists
    await queryRunner.query(`
      INSERT OR IGNORE INTO push_tokens (user_id, token, platform, provider, created_at)
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
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        token      VARCHAR(255) NOT NULL UNIQUE,
        platform   TEXT NOT NULL CHECK(platform IN ('ios', 'android')),
        created_at INTEGER DEFAULT (strftime('%s', 'now')) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 2. Migrate data back (only Firebase tokens)
    await queryRunner.query(`
      INSERT OR IGNORE INTO token_firebase (user_id, token, platform, created_at)
      SELECT user_id, token, platform, created_at
      FROM push_tokens
      WHERE provider = 'firebase'
    `);

    // 3. Drop push_tokens table
    await queryRunner.query(`DROP TABLE IF EXISTS push_tokens`);
  }
}
