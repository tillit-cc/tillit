import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('signal_key_types')
export class SignalKeyType {
  @PrimaryColumn()
  id: number;

  @Column({ length: 50, unique: true })
  code: string;

  @Column({ length: 100 })
  name: string;
}
