import { requiredEnvironmentValue } from './environment.js';
import type { ShelfPersistenceConfig } from './persistence.js';

export type ShelfPersistenceEnvironment = Readonly<Record<string, string | undefined>>;

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
    return {
      postgres: { connectionString },
      content: {
        driver,
        accountId: requiredEnvironmentValue(environment, 'SHELF_R2_ACCOUNT_ID'),
        bucket: requiredEnvironmentValue(environment, 'SHELF_R2_BUCKET'),
        accessKeyId: requiredEnvironmentValue(environment, 'SHELF_R2_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironmentValue(environment, 'SHELF_R2_SECRET_ACCESS_KEY'),
        ...(environment.SHELF_R2_SESSION_TOKEN === undefined
          ? {}
          : { sessionToken: environment.SHELF_R2_SESSION_TOKEN }),
        ...(environment.SHELF_STORAGE_PREFIX === undefined
          ? {}
          : { prefix: environment.SHELF_STORAGE_PREFIX }),
      },
    };
  }
  throw new Error('SHELF_STORAGE_DRIVER must be local or r2.');
}
