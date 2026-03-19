import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { IDatabaseAdapter } from './database.adapter.interface';

/**
 * MariaDB Database Adapter
 *
 * Used in CLOUD deployment mode
 * Provides scalable database backend for cloud deployment
 */
export class MariaDBAdapter implements IDatabaseAdapter {
  getTypeOrmConfig(): TypeOrmModuleOptions {
    return {
      type: 'mariadb',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'tillit',
      entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
      synchronize: process.env.NODE_ENV !== 'production',
      migrations: [__dirname + '/../migrations/mariadb/*{.ts,.js}'],
      migrationsRun: process.env.NODE_ENV === 'production',
      logging: process.env.DB_LOGGING === 'true',
      charset: 'utf8mb4',
      timezone: 'Z',
    };
  }

  getDatabaseType(): string {
    return 'MariaDB';
  }

  getMigrationsPath(): string {
    return 'src/database/migrations/mariadb';
  }

  validateConfig(): void {
    const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required MariaDB configuration: ${missing.join(', ')}`,
      );
    }
  }
}
