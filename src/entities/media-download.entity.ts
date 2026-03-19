import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { MediaBlob } from './media-blob.entity';
import { User } from './user.entity';

@Entity('media_downloads')
@Unique(['mediaId', 'userId'])
@Index(['mediaId'])
export class MediaDownload {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'media_id', length: 36 })
  mediaId: string;

  @Column({ name: 'user_id' })
  userId: number;

  @Column({ name: 'downloaded_at', type: 'bigint' })
  downloadedAt: number; // Unix timestamp in milliseconds

  // Relations
  @ManyToOne(() => MediaBlob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'media_id' })
  media: MediaBlob;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
