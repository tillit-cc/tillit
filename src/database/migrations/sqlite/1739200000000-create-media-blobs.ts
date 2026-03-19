import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMediaBlobs1739200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS media_blobs (
        id           VARCHAR(36) PRIMARY KEY,
        room_id      INTEGER NOT NULL,
        uploader_id  INTEGER NOT NULL,
        file_path    VARCHAR(500) NOT NULL,
        mime_type    VARCHAR(100) NOT NULL,
        size         INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms (id) ON DELETE CASCADE,
        FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Indexes for media_blobs
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_media_blobs_room
      ON media_blobs (room_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_media_blobs_uploader
      ON media_blobs (uploader_id)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_media_blobs_expires
      ON media_blobs (expires_at)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_blobs`);
  }
}
