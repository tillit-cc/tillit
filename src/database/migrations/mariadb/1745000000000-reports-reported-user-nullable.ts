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
    const fks: Array<{ CONSTRAINT_NAME: string }> = await queryRunner.query(`
      SELECT CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'reports'
        AND COLUMN_NAME = 'reported_user_id'
        AND REFERENCED_TABLE_NAME = 'users'
    `);

    for (const fk of fks) {
      await queryRunner.query(
        `ALTER TABLE reports DROP FOREIGN KEY ${fk.CONSTRAINT_NAME}`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE reports MODIFY reported_user_id INT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE reports
      ADD CONSTRAINT FK_reports_reported_user
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM reports WHERE reported_user_id IS NULL`,
    );

    const fks: Array<{ CONSTRAINT_NAME: string }> = await queryRunner.query(`
      SELECT CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'reports'
        AND COLUMN_NAME = 'reported_user_id'
        AND REFERENCED_TABLE_NAME = 'users'
    `);

    for (const fk of fks) {
      await queryRunner.query(
        `ALTER TABLE reports DROP FOREIGN KEY ${fk.CONSTRAINT_NAME}`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE reports MODIFY reported_user_id INT NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE reports
      ADD CONSTRAINT FK_reports_reported_user
      FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE
    `);
  }
}
