import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMediaBlobs1739200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS media_blobs (
        id           VARCHAR(36) PRIMARY KEY,
        room_id      INT NOT NULL,
        uploader_id  INT NOT NULL,
        file_path    VARCHAR(500) NOT NULL,
        mime_type    VARCHAR(100) NOT NULL,
        size         BIGINT NOT NULL,
        created_at   BIGINT NOT NULL,
        expires_at   BIGINT NOT NULL,
        INDEX IDX_media_blobs_room (room_id),
        INDEX IDX_media_blobs_uploader (uploader_id),
        INDEX IDX_media_blobs_expires (expires_at),
        CONSTRAINT FK_media_blobs_room
          FOREIGN KEY (room_id) REFERENCES rooms (id)
            ON DELETE CASCADE,
        CONSTRAINT FK_media_blobs_uploader
          FOREIGN KEY (uploader_id) REFERENCES users (id)
            ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_blobs`);
  }
}
