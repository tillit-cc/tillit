import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Liveness lock fix (ADR-0011). The `user_devices_last_active_at` trigger
 * rewrote `last_active_at = strftime('%s','now')` (epoch SECONDS, INTEGER) on
 * EVERY update. That:
 *   1. fought the application-owned liveness anchor (the throttled
 *      `touchPrimaryLiveness` and the aging used for enforcement), and
 *   2. stored an INTEGER where TypeORM otherwise wrote datetime strings, so the
 *      column read back inconsistently (number vs Date) and crashed
 *      `assertPrimaryActive` / device listing in production (migration schema).
 *
 * The application now owns `last_active_at` (writes epoch-ms via the entity;
 * reads are normalized by `utils/timestamp.toDate`), so the DB-side auto-update
 * must go. Dropping the trigger is reversible.
 */
export class FixUserDeviceLivenessTimestamp1748000000001
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS user_devices_last_active_at;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS user_devices_last_active_at
      AFTER UPDATE ON user_devices
      FOR EACH ROW
      BEGIN
        UPDATE user_devices SET last_active_at = strftime('%s', 'now') WHERE id = NEW.id;
      END
    `);
  }
}
