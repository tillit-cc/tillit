import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MariaDB twin of the sqlite migration. Per-device server-auth credential
 * (ADR-0010): bind a libsignal Curve25519 public key to `(user_id, device_id)`
 * for device-specific authentication at `POST /auth/identity`. Additive +
 * nullable.
 */
export class AddUserDeviceAuthKey1748000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices ADD COLUMN auth_public_key TEXT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_devices DROP COLUMN auth_public_key`,
    );
  }
}
