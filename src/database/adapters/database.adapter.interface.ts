import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Database Adapter Interface
 *
 * Provides a common interface for different database backends
 * Implementations: MariaDB (cloud), SQLite (self-hosted)
 */
export interface IDatabaseAdapter {
  /**
   * Get TypeORM configuration for this database adapter
   */
  getTypeOrmConfig(): TypeOrmModuleOptions;

  /**
   * Get database type identifier
   */
  getDatabaseType(): string;

  /**
   * Get migrations path for this adapter
   */
  getMigrationsPath(): string;

  /**
   * Validate configuration
   * Throws error if required environment variables are missing
   */
  validateConfig(): void;
}
