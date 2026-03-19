import { registerAs } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join, isAbsolute } from 'path';

const logger = new Logger('JwtConfiguration');

/**
 * Resolve key path - handles both absolute and relative paths
 */
function resolveKeyPath(keyPath: string): string {
  return isAbsolute(keyPath) ? keyPath : join(process.cwd(), keyPath);
}

export default registerAs('jwt', () => {
  const publicKeyPath = process.env.PUBLIC_KEY_PATH || './keys/public.pem';
  const privateKeyPath = process.env.PRIVATE_KEY_PATH || './keys/private.pem';

  const resolvedPublicPath = resolveKeyPath(publicKeyPath);
  const resolvedPrivatePath = resolveKeyPath(privateKeyPath);

  let publicKey = '';
  let privateKey = '';

  try {
    publicKey = readFileSync(resolvedPublicPath, 'utf8');
    logger.log(`Loaded public key from ${resolvedPublicPath}`);
  } catch (error) {
    logger.warn(
      `Could not read public key from ${resolvedPublicPath}: ${error.message}`,
    );
  }

  try {
    privateKey = readFileSync(resolvedPrivatePath, 'utf8');
    logger.log(`Loaded private key from ${resolvedPrivatePath}`);
  } catch (error) {
    logger.warn(
      `Could not read private key from ${resolvedPrivatePath}: ${error.message}`,
    );
  }

  return {
    algorithm: process.env.JWT_ALGORITHM || 'RS256',
    publicKeyPath,
    privateKeyPath,
    publicKey,
    privateKey,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  };
});
