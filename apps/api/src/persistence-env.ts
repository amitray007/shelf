import { requiredEnvironmentValue } from './environment.js';
import type { ShelfPersistenceConfig } from './persistence.js';

export type ShelfPersistenceEnvironment = Readonly<Record<string, string | undefined>>;

function optionalEnvironmentValue(
  environment: ShelfPersistenceEnvironment,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function shelfPersistenceConfigFromEnv(
  environment: ShelfPersistenceEnvironment = process.env,
): ShelfPersistenceConfig {
  const connectionString = requiredEnvironmentValue(environment, 'DATABASE_URL');
  const driver = requiredEnvironmentValue(environment, 'SHELF_STORAGE_DRIVER');
  if (driver === 'local') {
    return {
      postgres: { connectionString },
      content: {
        driver,
        root: requiredEnvironmentValue(environment, 'SHELF_STORAGE_LOCAL_ROOT'),
      },
    };
  }
  if (driver === 'r2') {
    const sessionToken = optionalEnvironmentValue(environment, 'SHELF_R2_SESSION_TOKEN');
    const prefix = optionalEnvironmentValue(environment, 'SHELF_STORAGE_PREFIX');
    return {
      postgres: { connectionString },
      content: {
        driver,
        accountId: requiredEnvironmentValue(environment, 'SHELF_R2_ACCOUNT_ID'),
        bucket: requiredEnvironmentValue(environment, 'SHELF_R2_BUCKET'),
        accessKeyId: requiredEnvironmentValue(environment, 'SHELF_R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironmentValue(environment, 'SHELF_R2_SECRET_ACCESS_KEY'),
        ...(sessionToken === undefined ? {} : { sessionToken }),
        ...(prefix === undefined ? {} : { prefix }),
      },
    };
  }
  throw new Error('SHELF_STORAGE_DRIVER must be local or r2.');
}
