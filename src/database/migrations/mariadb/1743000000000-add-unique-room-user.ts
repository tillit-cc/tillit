import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueRoomUser1743000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove duplicate rows first (keep earliest joined)
    await queryRunner.query(`
      DELETE ru1 FROM room_users ru1
      INNER JOIN room_users ru2
      ON ru1.room_id = ru2.room_id AND ru1.user_id = ru2.user_id AND ru1.id > ru2.id
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IDX_room_users_room_user ON room_users (room_id, user_id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IDX_room_users_room_user ON room_users`,
    );
  }
}
