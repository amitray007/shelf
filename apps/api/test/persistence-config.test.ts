import { describe, expect, it } from 'vitest';

import { shelfPersistenceConfigFromEnv } from '../src/persistence-env.js';

describe('shelfPersistenceConfigFromEnv', () => {
  it('builds the local single-host profile from explicit variables', () => {
    expect(
      shelfPersistenceConfigFromEnv({
        DATABASE_URL: 'postgresql://shelf@postgres/shelf',
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: '/var/lib/shelf/content',
      }),
    ).toEqual({
      postgres: { connectionString: 'postgresql://shelf@postgres/shelf' },
      content: { driver: 'local', root: '/var/lib/shelf/content' },
    });
  });

  it('builds the R2 profile without placing credentials in provider-neutral fields', () => {
    expect(
      shelfPersistenceConfigFromEnv({
        DATABASE_URL: 'postgresql://shelf@postgres/shelf',
        SHELF_STORAGE_DRIVER: 'r2',
        SHELF_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        SHELF_R2_BUCKET: 'shelf-content',
        SHELF_R2_ACCESS_KEY_ID: 'access-key',
        SHELF_R2_SECRET_ACCESS_KEY: 'secret-key',
        SHELF_STORAGE_PREFIX: 'production/shelf',
      }),
    ).toEqual({
      postgres: { connectionString: 'postgresql://shelf@postgres/shelf' },
      content: {
        driver: 'r2',
        accountId: '0123456789abcdef0123456789abcdef',
        bucket: 'shelf-content',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
        prefix: 'production/shelf',
      },
    });
  });

  it('names a missing variable without echoing another credential', () => {
    expect(() =>
      shelfPersistenceConfigFromEnv({
        DATABASE_URL: 'postgresql://shelf@postgres/shelf',
        SHELF_STORAGE_DRIVER: 'r2',
        SHELF_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        SHELF_R2_BUCKET: 'shelf-content',
        SHELF_R2_ACCESS_KEY_ID: 'do-not-print-this',
      }),
    ).toThrow('SHELF_R2_SECRET_ACCESS_KEY');
  });
});
