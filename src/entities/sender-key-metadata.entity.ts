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

@Entity('sender_key_metadata')
@Index(['roomId', 'senderUserId', 'active'])
@Index(['roomId', 'senderUserId', 'distributionId'], { unique: true })
export class SenderKeyMetadata {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ name: 'distribution_id', length: 36 })
  distributionId: string;

  @Column({ name: 'sender_user_id' })
  senderUserId: number;

  @Column({ name: 'created_by' })
  createdBy: number;

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number;

  @Column({ name: 'rotated_at', type: 'bigint', nullable: true })
  rotatedAt?: number;

  @Column({ default: true })
  active: boolean;

  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_user_id' })
  senderUser: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator: User;
}
