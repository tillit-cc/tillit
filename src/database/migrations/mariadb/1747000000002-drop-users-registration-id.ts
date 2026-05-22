import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MariaDB twin of the sqlite migration. See the sqlite file for rationale —
 * `registration_id` is per-device (`user_devices.registration_id`); the
 * user-level column is unused and was blocking multi-device pairing.
 */
export class DropUsersRegistrationId1747000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN registration_id`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN registration_id INT NOT NULL DEFAULT 0`,
    );
  }
}
