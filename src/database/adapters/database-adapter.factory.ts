import { DEPLOYMENT_MODE, DeploymentMode } from '../../config/deployment-mode';
import { IDatabaseAdapter } from './database.adapter.interface';
import { MariaDBAdapter } from './mariadb.adapter';
import { SQLiteAdapter } from './sqlite.adapter';

/**
 * Database Adapter Factory
 *
 * Returns the appropriate database adapter based on deployment mode
 */
export class DatabaseAdapterFactory {
  static createAdapter(): IDatabaseAdapter {
    switch (DEPLOYMENT_MODE) {
      case DeploymentMode.CLOUD:
        return new MariaDBAdapter();
      case DeploymentMode.SELFHOSTED:
        return new SQLiteAdapter();
      default:
        throw new Error(`Unknown deployment mode: ${String(DEPLOYMENT_MODE)}`);
    }
  }
}
