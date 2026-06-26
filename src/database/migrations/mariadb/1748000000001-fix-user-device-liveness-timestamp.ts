import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Liveness lock fix (ADR-0011), MariaDB twin of the sqlite migration. Here
 * `last_active_at` was `TIMESTAMP ... ON UPDATE CURRENT_TIMESTAMP`, so the DB
 * auto-bumped it on every row update — the same problem as the sqlite trigger:
 * it fought the application-owned liveness anchor (throttled refresh + aging
 * used for enforcement). The application now owns `last_active_at`, so drop the
 * `ON UPDATE` clause (keep the column + its insert default). Reversible.
 */
export class FixUserDeviceLivenessTimestamp1748000000001
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices
       MODIFY COLUMN last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices
       MODIFY COLUMN last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    );
  }
}
