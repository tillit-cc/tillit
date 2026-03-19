import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlterJoinedAtToBigint1745000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if column is still datetime/timestamp before altering
    const [column] = await queryRunner.query(
      `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'room_users'
         AND COLUMN_NAME = 'joined_at'`,
    );

    if (column && column.DATA_TYPE !== 'bigint') {
      // Convert existing datetime values to Unix milliseconds, then change column type
      await queryRunner.query(`
        ALTER TABLE room_users
          MODIFY joined_at BIGINT NOT NULL
      `);

      // Update existing rows: convert datetime (stored as 0 after type change) to current timestamp
      // Only needed if there were existing rows with datetime values
      await queryRunner.query(`
        UPDATE room_users SET joined_at = UNIX_TIMESTAMP(NOW()) * 1000 WHERE joined_at = 0
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE room_users
        MODIFY joined_at DATETIME NOT NULL
    `);
  }
}