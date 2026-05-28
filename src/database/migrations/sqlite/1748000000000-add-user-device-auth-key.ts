import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-device server-auth credential (ADR-0010): each device binds a dedicated
 * libsignal Curve25519 public key to `(user_id, device_id)`, used to
 * authenticate that specific device at `POST /auth/identity` (closes finding
 * #4 — a linked device claiming `deviceId: 1`). Additive + nullable: existing
 * rows keep working in transition mode until the device registers its key.
 */
export class AddUserDeviceAuthKey1748000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN auth_public_key TEXT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // SQLite ≥ 3.35 supports DROP COLUMN natively (baseline of this family).
    await queryRunner.query(
      `ALTER TABLE user_devices DROP COLUMN auth_public_key`,
    );
  }
}
