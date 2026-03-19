import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { isSelfHostedMode } from '../config/deployment-mode';

export enum Platform {
  IOS = 'ios',
  ANDROID = 'android',
}

export enum PushProvider {
  EXPO = 'expo',
  FIREBASE = 'firebase',
}

const columnType = isSelfHostedMode() ? 'varchar' : 'enum';

@Entity('push_tokens')
export class PushToken {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ unique: true })
  token: string;

  @Column({
    type: columnType,
    enum: Platform,
  })
  platform: Platform;

  @Column({
    type: columnType,
    enum: PushProvider,
    default: PushProvider.EXPO,
  })
  provider: PushProvider;

  @Column({ default: 'en', length: 5 })
  lang: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.pushTokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
