import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { RoomUser } from './room-user.entity';
import { PushToken } from './push-token.entity';
import { SignalKey } from './signal-key.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'identity_public_key', unique: true, length: 500 })
  identityPublicKey: string; // Base64-encoded Signal Protocol identity key

  @Column({ name: 'registration_id' })
  registrationId: number; // Signal Protocol registration ID

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  // Relations
  @OneToMany(() => RoomUser, (roomUser) => roomUser.user)
  roomMemberships: RoomUser[];

  @OneToMany(() => PushToken, (token) => token.user)
  pushTokens: PushToken[];

  @OneToMany(() => SignalKey, (key) => key.user)
  signalKeys: SignalKey[];
}
