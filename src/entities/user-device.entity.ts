import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('user_devices')
@Index(['userId', 'deviceId'], { unique: true })
export class UserDevice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ name: 'device_id' })
  deviceId: number;

  @Column({ name: 'registration_id' })
  registrationId: number;

  @Column({ name: 'identity_public_key', type: 'text' })
  identityPublicKey: string;

  @Column({ nullable: true, length: 100 })
  name?: string;

  @UpdateDateColumn({ name: 'last_active_at' })
  lastActiveAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
