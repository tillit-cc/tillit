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

@Entity('sender_key_distributions')
@Index(['roomId', 'recipientUserId'])
@Index(['roomId', 'distributionId'])
export class SenderKeyDistribution {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ name: 'sender_user_id' })
  senderUserId: number;

  // Nullable for backward compat with rows written before the H-04 fix —
  // client falls back to deviceId=1 (matches single-device reality today).
  @Column({ name: 'sender_device_id', type: 'int', nullable: true })
  senderDeviceId: number | null;

  @Column({ name: 'distribution_id', length: 36 })
  distributionId: string;

  @Column({ name: 'encrypted_sender_key', type: 'text' })
  encryptedSenderKey: string; // Encrypted with recipient's pair-wise session

  @Column({ name: 'recipient_user_id' })
  recipientUserId: number;

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number;

  @Column({ default: false })
  delivered: boolean;

  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_user_id' })
  senderUser: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_user_id' })
  recipientUser: User;
}
