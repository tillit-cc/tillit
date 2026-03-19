import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEphemeralMedia1740000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add ephemeral columns to media_blobs
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN max_downloads INTEGER DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0`,
    );

    // Create media_downloads table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS media_downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id VARCHAR(36) NOT NULL,
        user_id INTEGER NOT NULL,
        downloaded_at INTEGER NOT NULL,
        FOREIGN KEY (media_id) REFERENCES media_blobs(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE (media_id, user_id)
      )
    `);

    // Index for media_downloads
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_media_downloads_media
      ON media_downloads (media_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_downloads`);
    // SQLite doesn't support DROP COLUMN before 3.35.0
    // For older versions, we'd need to recreate the table
    // Assuming SQLite 3.35+ is available
    await queryRunner.query(
      `ALTER TABLE media_blobs DROP COLUMN download_count`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs DROP COLUMN max_downloads`,
    );
    await queryRunner.query(`ALTER TABLE media_blobs DROP COLUMN ephemeral`);
  }
}
