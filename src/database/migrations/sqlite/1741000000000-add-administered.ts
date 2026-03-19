import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdministered1741000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE rooms ADD COLUMN administered INTEGER NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite does not support DROP COLUMN before 3.35.0
    // For older versions, table recreation would be needed
    await queryRunner.query(`ALTER TABLE rooms DROP COLUMN administered`);
  }
}
