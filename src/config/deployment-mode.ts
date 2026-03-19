/**
 * Deployment Mode Configuration
 *
 * TilliT supports two deployment modes:
 * - CLOUD: Full-featured version with MariaDB + Redis for scalable cloud deployment
 * - SELFHOSTED: Lightweight version with SQLite for Raspberry Pi / self-hosted hardware
 */

export enum DeploymentMode {
  CLOUD = 'cloud',
  SELFHOSTED = 'selfhosted',
}

/**
 * Current deployment mode
 * Set via DEPLOYMENT_MODE environment variable
 * Defaults to CLOUD if not specified
 */
export const DEPLOYMENT_MODE =
  (process.env.DEPLOYMENT_MODE as DeploymentMode) || DeploymentMode.CLOUD;

/**
 * Check if running in cloud mode
 */
export const isCloudMode = () => DEPLOYMENT_MODE === DeploymentMode.CLOUD;

/**
 * Check if running in self-hosted mode
 */
export const isSelfHostedMode = () =>
  DEPLOYMENT_MODE === DeploymentMode.SELFHOSTED;

/**
 * Log current deployment mode
 */
export function logDeploymentMode() {
  const { Logger } = require('@nestjs/common');
  const logger = new Logger('DeploymentMode');
  logger.log(`Deployment Mode: ${DEPLOYMENT_MODE}`);
  logger.log(`Database: ${isCloudMode() ? 'MariaDB' : 'SQLite'}`);
  logger.log(`Redis: ${isCloudMode() ? 'Enabled' : 'Disabled'}`);
  logger.log(
    `DDNS: ${process.env.DDNS_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`,
  );
}
