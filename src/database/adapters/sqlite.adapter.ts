import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { IDatabaseAdapter } from './database.adapter.interface';
import * as path from 'path';
import * as fs from 'fs';

/**
 * SQLite Database Adapter
 *
 * Used in SELFHOSTED deployment mode
 * Provides lightweight database backend for Raspberry Pi / embedded devices
 */
export class SQLiteAdapter implements IDatabaseAdapter {
  private readonly dataDir: string;

  constructor() {
    // Data directory for SQLite database
    this.dataDir =
      process.env.SQLITE_DATA_DIR || path.join(process.cwd(), 'data');

    // Create data directory if it doesn't exist
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  getTypeOrmConfig(): TypeOrmModuleOptions {
    const dbPath = path.join(this.dataDir, 'tillit.db');

    return {
      type: 'better-sqlite3',
      database: dbPath,
      entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
      synchronize: process.env.NODE_ENV !== 'production',
      migrations: [__dirname + '/../migrations/sqlite/*{.ts,.js}'],
      migrationsRun: process.env.NODE_ENV === 'production',
      logging: process.env.DB_LOGGING === 'true',
      // SQLite-specific options
      prepareDatabase: (db: any) => {
        // Enable foreign keys
        db.pragma('foreign_keys = ON');
        // Enable WAL mode for better concurrency
        db.pragma('journal_mode = WAL');
        // Increase cache size (in pages, -10000 = ~10MB)
        db.pragma('cache_size = -10000');
        // Synchronous mode for better performance (but less durability)
        db.pragma('synchronous = NORMAL');
      },
    };
  }

  getDatabaseType(): string {
    return 'SQLite';
  }

  getMigrationsPath(): string {
    return 'src/database/migrations/sqlite';
  }

  validateConfig(): void {
    // SQLite has minimal config requirements
    // Just ensure data directory is writable
    try {
      fs.accessSync(this.dataDir, fs.constants.W_OK);
    } catch {
      throw new Error(`SQLite data directory is not writable: ${this.dataDir}`);
    }
  }
}
