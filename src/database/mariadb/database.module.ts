import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseAdapterFactory } from '../adapters/database-adapter.factory';
import { DatabaseSeederService } from '../database-seeder.service';
import { logDeploymentMode } from '../../config/deployment-mode';

/**
 * Database Module with conditional adapter loading
 *
 * Automatically selects the correct database backend based on DEPLOYMENT_MODE:
 * - CLOUD: MariaDB (scalable, multi-instance)
 * - SELFHOSTED: SQLite (lightweight, single-instance)
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        // Log deployment mode on startup
        logDeploymentMode();

        // Get appropriate adapter based on deployment mode
        const adapter = DatabaseAdapterFactory.createAdapter();

        // Validate configuration
        adapter.validateConfig();

        const { Logger } = require('@nestjs/common');
        new Logger('DatabaseModule').log(
          `Using ${adapter.getDatabaseType()} adapter`,
        );

        // Return TypeORM configuration
        return adapter.getTypeOrmConfig();
      },
    }),
  ],
  providers: [DatabaseSeederService],
})
export class DatabaseModule {}
