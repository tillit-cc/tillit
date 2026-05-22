import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum DeviceLinkSessionStatus {
  WAITING = 'waiting',
  PUBKEY_SHARED = 'pubkey-shared',
  COMPLETED = 'completed',
  CONSUMED = 'consumed',
  EXPIRED = 'expired',
}

/**
 * Pairing session for wire v2. Created anonymously by the new device via
 * `POST /auth/devices/link/init`; the primary attaches its userId/deviceId
 * only at `/link/complete`. See `_shared/api/multi-device-linking.md`.
 */
@Entity('device_link_sessions')
@Index(['status', 'expiresAt'])
@Index(['expiresAt'])
export class DeviceLinkSession {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'session_id', length: 43, unique: true })
  sessionId: string;

  @Column({ name: 'primary_user_id', type: 'int', nullable: true })
  primaryUserId?: number | null;

  @Column({ name: 'primary_device_id', type: 'int', nullable: true })
  primaryDeviceId?: number | null;

  @Column({
    name: 'ephemeral_public_key',
    type: 'varchar',
    length: 64,
  })
  ephemeralPublicKey: string;

  @Column({ name: 'device_name', type: 'varchar', length: 64, nullable: true })
  deviceName?: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, nullable: true })
  userAgent?: string | null;

  @Column({ name: 'encrypted_payload', type: 'blob', nullable: true })
  encryptedPayload?: Buffer | null;

  @Column({
    name: 'primary_ephemeral_pub_key',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  primaryEphemeralPubKey?: string | null;

  @Column({ name: 'assigned_device_id', type: 'int', nullable: true })
  assignedDeviceId?: number | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: DeviceLinkSessionStatus.WAITING,
  })
  status: DeviceLinkSessionStatus;

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number;

  @Column({ name: 'expires_at', type: 'bigint' })
  expiresAt: number;

  @Column({ name: 'consumed_at', type: 'bigint', nullable: true })
  consumedAt?: number | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'primary_user_id' })
  primaryUser?: User | null;
}
