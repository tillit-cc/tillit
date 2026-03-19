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

@Entity('media_blobs')
@Index(['roomId'])
@Index(['uploaderId'])
@Index(['expiresAt'])
export class MediaBlob {
  @PrimaryColumn({ length: 36 })
  id: string; // UUID

  @Column({ name: 'room_id' })
  roomId: number;

  @Column({ name: 'uploader_id' })
  uploaderId: number;

  @Column({ name: 'file_path', length: 500 })
  filePath: string; // Path to encrypted blob on filesystem

  @Column({ name: 'mime_type', length: 100 })
  mimeType: string;

  @Column({ type: 'bigint' })
  size: number; // File size in bytes

  @Column({ name: 'created_at', type: 'bigint' })
  createdAt: number; // Unix timestamp in milliseconds

  @Column({ name: 'expires_at', type: 'bigint' })
  expiresAt: number; // Unix timestamp in milliseconds

  @Column({ default: false })
  ephemeral: boolean;

  @Column({ name: 'max_downloads', type: 'int', nullable: true })
  maxDownloads: number | null; // null = unlimited

  @Column({ name: 'download_count', default: 0 })
  downloadCount: number;

  // Relations
  @ManyToOne(() => Room, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'room_id' })
  room: Room;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'uploader_id' })
  uploader: User;
}
