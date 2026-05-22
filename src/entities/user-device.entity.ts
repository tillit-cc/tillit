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

export enum UserDeviceStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
  PENDING_LINK = 'pending_link',
}

@Entity('user_devices')
@Index(['userId', 'deviceId'], { unique: true })
@Index(['userId', 'status'])
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

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: UserDeviceStatus.ACTIVE,
  })
  status: UserDeviceStatus;

  @Column({ name: 'device_name', type: 'varchar', length: 64, nullable: true })
  deviceName?: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, nullable: true })
  userAgent?: string | null;

  @UpdateDateColumn({ name: 'last_active_at' })
  lastActiveAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Bigint epoch-ms — stored as INTEGER/BIGINT across SQLite and MariaDB.
  // `timestamp` would be cleaner but better-sqlite3 has no native support.
  @Column({ name: 'revoked_at', type: 'bigint', nullable: true })
  revokedAt?: number | null;

  // Relations
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
