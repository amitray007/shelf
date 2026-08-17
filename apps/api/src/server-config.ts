import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import {
  installationIdFromEnvironment,
  requiredEnvironmentValue,
  type ShelfEnvironment,
} from './environment.js';
import type { ShelfPersistenceConfig } from './persistence.js';
import { shelfPersistenceConfigFromEnv } from './persistence-env.js';

export type ShelfServerEnvironment = ShelfEnvironment;

export interface ShelfServerConfig {
  host: string;
  port: number;
  installationId: string;
  auth: { baseUrl: string; secret: string };
  persistence: ShelfPersistenceConfig;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === '127.0.0.1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}

async function loadAuthSecret(environment: ShelfServerEnvironment): Promise<string> {
  const inline = environment.SHELF_AUTH_SECRET;
  const file = environment.SHELF_AUTH_SECRET_FILE;
  if ((inline === undefined) === (file === undefined)) {
    throw new Error('Configure exactly one of SHELF_AUTH_SECRET or SHELF_AUTH_SECRET_FILE.');
  }
  const secret = inline ?? (await readFile(file as string, 'utf8')).replace(/\r?\n$/u, '');
  if (
    secret.length < 32 ||
    secret.includes('\u0000') ||
    secret.includes('\r') ||
    secret.includes('\n')
  ) {
    throw new Error('The configured authentication secret is invalid.');
  }
  return secret;
}

export async function loadShelfServerConfig(
  environment: ShelfServerEnvironment = process.env,
): Promise<ShelfServerConfig> {
  const installationId = installationIdFromEnvironment(environment);

  const baseUrl = new URL(requiredEnvironmentValue(environment, 'SHELF_AUTH_BASE_URL'));
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new Error('SHELF_AUTH_BASE_URL must use HTTP or HTTPS.');
  }
  if (baseUrl.protocol !== 'https:' && !isLoopback(baseUrl.hostname)) {
    throw new Error('SHELF_AUTH_BASE_URL must use HTTPS except on loopback.');
  }
  if (
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0 ||
    baseUrl.pathname !== '/' ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  ) {
    throw new Error('SHELF_AUTH_BASE_URL must be an origin without credentials, path, or query.');
  }

  const portText = environment.SHELF_PORT ?? '3000';
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SHELF_PORT must be an integer from 1 to 65535.');
  }

  const host = environment.SHELF_HOST ?? '127.0.0.1';
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes('\u0000') ||
    host.includes('\r') ||
    host.includes('\n')
  ) {
    throw new Error('SHELF_HOST is invalid.');
  }

  return {
    host,
    port,
    installationId,
    auth: {
      baseUrl: baseUrl.toString().replace(/\/$/u, ''),
      secret: await loadAuthSecret(environment),
    },
    persistence: shelfPersistenceConfigFromEnv(environment),
  };
}
