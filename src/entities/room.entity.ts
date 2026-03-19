import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { RoomUser } from './room-user.entity';

export enum RoomStatus {
  CREATED = 0,
  ACTIVE = 1,
  ARCHIVED = 2,
  DELETED = 3,
}

@Entity('rooms')
export class Room {
  @PrimaryGeneratedColumn()
  id: number; // Internal primary key

  @Column({ name: 'invite_code', unique: true, length: 20 })
  inviteCode: string; // Public invite code

  @Column({ nullable: true, length: 30 })
  name: string; // Room display name (max 30 chars)

  @Column({ type: 'tinyint', default: RoomStatus.CREATED })
  status: RoomStatus;

  @Column({ name: 'id_user' })
  idUser: number; // Creator user ID

  // Sender Keys fields
  @Column({ name: 'use_sender_keys', type: 'tinyint', default: 0 })
  useSenderKeys: boolean;

  @Column({ name: 'administered', type: 'tinyint', default: 0 })
  administered: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Relations
  @OneToMany(() => RoomUser, (roomUser) => roomUser.room)
  roomUsers: RoomUser[];
}
