import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { SignalKeyType } from './signal-key-type.entity';

export enum KeyTypeId {
  PRE_KEY = 1,
  KYBER_PRE_KEY = 2,
  SIGNED_PRE_KEY = 3,
}

@Entity('signal_keys')
@Index(['userId', 'deviceId', 'keyTypeId'])
export class SignalKey {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ name: 'device_id', length: 100 })
  deviceId: string;

  @Column({ name: 'key_type' })
  keyTypeId: number;

  @ManyToOne(() => SignalKeyType)
  @JoinColumn({ name: 'key_type' })
  keyType: SignalKeyType;

  @Column({ name: 'key_id' })
  keyId: number;

  @Column({ name: 'key_data', type: 'text' })
  keyData: string;

  @Column({ name: 'key_signature', type: 'text', nullable: true })
  keySignature?: string | null;

  @Column({ default: false })
  consumed: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.signalKeys, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
