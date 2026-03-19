import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdministered1741000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE rooms ADD COLUMN administered TINYINT(1) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE rooms DROP COLUMN administered`);
  }
}
