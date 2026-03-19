import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueRoomUser1743000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove duplicate rows first (keep earliest joined)
    await queryRunner.query(`
      DELETE FROM room_users WHERE id NOT IN (
        SELECT MIN(id) FROM room_users GROUP BY room_id, user_id
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IDX_room_users_room_user ON room_users (room_id, user_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IDX_room_users_room_user`);
  }
}
