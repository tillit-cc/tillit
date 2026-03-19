import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { Room } from './room.entity';

@Entity('pending_messages')
@Index(['userId', 'roomId'])
@Index(['expiresAt'])
export class PendingMessage {
  @PrimaryColumn({ length: 36 })
  id: string; // UUID

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ type: 'text' })
  envelope: string; // JSON serialized MessageEnvelope

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number; // Unix timestamp in milliseconds

  @Column({ name: 'expires_at', type: 'bigint' })
  expiresAt: number; // Unix timestamp in milliseconds

  @Column({ default: 0 })
  attempts: number; // Delivery attempt count

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;
}
