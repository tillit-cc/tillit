import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Room } from './room.entity';
import { User } from './user.entity';

@Entity('room_users')
@Index(['roomId', 'userId'], { unique: true })
export class RoomUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ nullable: true, length: 100 })
  username: string;

  @Column({ name: 'joined_at', type: 'bigint' })
  joinedAt: number; // Unix timestamp in milliseconds (Date.now())

  // Relations
  @ManyToOne(() => Room, (room) => room.roomUsers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  @ManyToOne(() => User, (user) => user.roomMemberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
