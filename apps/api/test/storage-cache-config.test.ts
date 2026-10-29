import { describe, expect, it } from 'vitest';

import { shelfPersistenceConfigFromEnv } from '../src/persistence-env.js';

const environment = {
  DATABASE_URL: 'postgresql://shelf@postgres/shelf',
  SHELF_STORAGE_DRIVER: 'r2',
  SHELF_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  SHELF_R2_BUCKET: 'shelf-content',
  SHELF_R2_ACCESS_KEY_ID: 'access-key',
  SHELF_R2_SECRET_ACCESS_KEY: 'secret-key',
};

describe('R2 cache environment', () => {
  it.each(['0', '64', '134217728'])('accepts %s bytes for API and renderer assembly', (value) => {
    expect(
      shelfPersistenceConfigFromEnv({ ...environment, SHELF_STORAGE_CACHE_BYTES: value }).content,
    ).toMatchObject({ driver: 'r2', cacheBytes: Number(value) });
  });

  it.each(['-1', '1.5', 'NaN', 'Infinity', ' ', '9007199254740992'])('rejects %s', (value) => {
    expect(() =>
      shelfPersistenceConfigFromEnv({ ...environment, SHELF_STORAGE_CACHE_BYTES: value }),
    ).toThrow('SHELF_STORAGE_CACHE_BYTES');
  });

  it('leaves local storage unchanged', () => {
    expect(
      shelfPersistenceConfigFromEnv({
        ...environment,
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: '/tmp/content',
        SHELF_STORAGE_CACHE_BYTES: 'invalid',
      }).content,
    ).toEqual({ driver: 'local', root: '/tmp/content' });
  });
});
