import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Room } from './room.entity';

@Entity('reports')
export class Report {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'reporter_user_id' })
  reporterUserId: number;

  @Column({ name: 'reported_user_id' })
  reportedUserId: number;

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ name: 'message_id', type: 'varchar', nullable: true, length: 36 })
  messageId: string | null;

  @Column({ length: 50 })
  reason: string; // 'spam', 'harassment', 'illegal_content', 'other'

  @Column({ type: 'varchar', nullable: true, length: 500 })
  description: string | null;

  @Column({ length: 20, default: 'pending' })
  status: string; // 'pending', 'reviewed', 'dismissed', 'actioned'

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reporter_user_id' })
  reporter: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reported_user_id' })
  reportedUser: User;

  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;
}
