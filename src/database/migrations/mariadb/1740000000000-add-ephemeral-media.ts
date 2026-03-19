import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEphemeralMedia1740000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add ephemeral columns to media_blobs
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN ephemeral TINYINT(1) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN max_downloads INT DEFAULT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs ADD COLUMN download_count INT NOT NULL DEFAULT 0`,
    );

    // Create media_downloads table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS media_downloads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        media_id VARCHAR(36) NOT NULL,
        user_id INT NOT NULL,
        downloaded_at BIGINT NOT NULL,
        CONSTRAINT FK_media_downloads_media
          FOREIGN KEY (media_id) REFERENCES media_blobs(id)
            ON DELETE CASCADE,
        CONSTRAINT FK_media_downloads_user
          FOREIGN KEY (user_id) REFERENCES users(id)
            ON DELETE CASCADE,
        UNIQUE KEY UQ_media_downloads_media_user (media_id, user_id),
        INDEX IDX_media_downloads_media (media_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_downloads`);
    await queryRunner.query(
      `ALTER TABLE media_blobs DROP COLUMN download_count`,
    );
    await queryRunner.query(
      `ALTER TABLE media_blobs DROP COLUMN max_downloads`,
    );
    await queryRunner.query(`ALTER TABLE media_blobs DROP COLUMN ephemeral`);
  }
}
