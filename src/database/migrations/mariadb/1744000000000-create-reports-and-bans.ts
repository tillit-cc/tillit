import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReportsAndBans1744000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_user_id INT NOT NULL,
        reported_user_id INT NOT NULL,
        room_id INT NOT NULL,
        message_id VARCHAR(36),
        reason VARCHAR(50) NOT NULL,
        description VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at BIGINT NOT NULL,
        FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        reason VARCHAR(500),
        banned_at BIGINT NOT NULL,
        UNIQUE KEY UQ_banned_users_user_id (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS banned_users`);
    await queryRunner.query(`DROP TABLE IF EXISTS reports`);
  }
}
