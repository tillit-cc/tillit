import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SignalKeyType } from '../entities/signal-key-type.entity';

/**
 * Seeds required reference data on application startup.
 *
 * When using TypeORM's `synchronize: true` (development), tables are created
 * from entities but migrations don't run — so reference/lookup tables like
 * `signal_key_types` would be empty. This seeder ensures they're populated
 * regardless of whether migrations have run.
 *
 * Works with both MariaDB (cloud) and SQLite (selfhosted).
 */
@Injectable()
export class DatabaseSeederService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseSeederService.name);

  constructor(private dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.seedSignalKeyTypes();
  }

  private async seedSignalKeyTypes(): Promise<void> {
    const repo = this.dataSource.getRepository(SignalKeyType);
    const count = await repo.count();
    if (count >= 3) return; // Already seeded (via migrations or previous run)

    const types = [
      { id: 1, code: 'preKey', name: 'Pre Key' },
      { id: 2, code: 'kyberPreKey', name: 'Kyber Pre Key' },
      { id: 3, code: 'signedPreKey', name: 'Signed Pre Key' },
    ];

    for (const type of types) {
      const existing = await repo.findOne({ where: { id: type.id } });
      if (!existing) {
        await repo.save(repo.create(type));
      }
    }

    this.logger.log('Signal key types seeded');
  }
}
