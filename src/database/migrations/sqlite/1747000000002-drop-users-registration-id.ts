import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-device pairing makes `registration_id` a per-device value
 * (`user_devices.registration_id`). The user-level column is dead weight and
 * actively harmful: `POST /auth/identity` was throwing 409 when a freshly
 * linked device's registrationId did not match the primary's. Drop the
 * column; entity and service no longer reference it.
 *
 * See _shared/tasks/backend-0007-per-device-registration-id.md (Option A).
 */
export class DropUsersRegistrationId1747000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite ≥ 3.35 supports DROP COLUMN natively. The rest of this migration
    // family already assumes 3.35+ (see 1747000000001-add-recipient-device-id).
    await queryRunner.query(`ALTER TABLE users DROP COLUMN registration_id`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add the column with a default so any existing rows back-fill cleanly.
    // The value is irrelevant — the column is unused at the app level after
    // this migration runs forward.
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN registration_id INTEGER NOT NULL DEFAULT 0`,
    );
  }
}
