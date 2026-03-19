import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLangToPushTokens1742000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE push_tokens ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE push_tokens DROP COLUMN lang`);
  }
}
