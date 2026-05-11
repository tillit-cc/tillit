import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make reports.reported_user_id nullable with ON DELETE SET NULL.
 *
 * Required so that when an account is deleted, reports filed *against*
 * that user are preserved for audit (with reported_user_id = NULL) while
 * reports filed *by* that user still cascade away.
 */
export class ReportsReportedUserNullable1745000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE reports_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_user_id INTEGER NOT NULL,
        reported_user_id INTEGER,
        room_id INTEGER NOT NULL,
        message_id VARCHAR(36),
        reason VARCHAR(50) NOT NULL,
        description VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      INSERT INTO reports_new (
        id, reporter_user_id, reported_user_id, room_id, message_id,
        reason, description, status, created_at
      )
      SELECT
        id, reporter_user_id, reported_user_id, room_id, message_id,
        reason, description, status, created_at
      FROM reports
    `);

    await queryRunner.query(`DROP TABLE reports`);
    await queryRunner.query(`ALTER TABLE reports_new RENAME TO reports`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop rows that would violate the restored NOT NULL constraint
    await queryRunner.query(
      `DELETE FROM reports WHERE reported_user_id IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE reports_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_user_id INTEGER NOT NULL,
        reported_user_id INTEGER NOT NULL,
        room_id INTEGER NOT NULL,
        message_id VARCHAR(36),
        reason VARCHAR(50) NOT NULL,
        description VARCHAR(500),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      INSERT INTO reports_old (
        id, reporter_user_id, reported_user_id, room_id, message_id,
        reason, description, status, created_at
      )
      SELECT
        id, reporter_user_id, reported_user_id, room_id, message_id,
        reason, description, status, created_at
      FROM reports
    `);

    await queryRunner.query(`DROP TABLE reports`);
    await queryRunner.query(`ALTER TABLE reports_old RENAME TO reports`);
  }
}
