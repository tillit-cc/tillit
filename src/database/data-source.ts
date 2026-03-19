import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import * as path from 'path';

// Load environment variables
config();

const isSelfHosted = process.env.DEPLOYMENT_MODE === 'selfhosted';

/**
 * MariaDB configuration for CLOUD mode
 */
const mariadbConfig: DataSourceOptions = {
  type: 'mariadb',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tillit',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/mariadb/*.ts'],
  synchronize: false,
  logging: true,
};

/**
 * SQLite configuration for SELFHOSTED mode
 */
const sqliteConfig: DataSourceOptions = {
  type: 'better-sqlite3',
  database: path.join(process.env.SQLITE_DATA_DIR || './data', 'tillit.db'),
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/sqlite/*.ts'],
  synchronize: false,
  logging: true,
};

/**
 * Export DataSource based on DEPLOYMENT_MODE
 * - CLOUD (default): MariaDB
 * - SELFHOSTED: SQLite
 */
export const AppDataSource = new DataSource(
  isSelfHosted ? sqliteConfig : mariadbConfig,
);
