import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { shelfPersistenceConfigFromEnv } from '../src/persistence-env.js';

const execFileAsync = promisify(execFile);

describe('renderer storage cache environment', () => {
  it.each(['0', '134217728', ''])(
    'forwards the cache budget %j through the allowlist',
    async (value) => {
      const script = new URL('../scripts/renderer-environment.mjs', import.meta.url).href;
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { rendererEnvironment } from ${JSON.stringify(script)}; process.stdout.write(JSON.stringify(rendererEnvironment(process.env)));`,
        ],
        { env: { ...process.env, SHELF_STORAGE_CACHE_BYTES: value } },
      );
      expect(stderr).toBe('');
      expect(JSON.parse(stdout).SHELF_STORAGE_CACHE_BYTES).toBe(value);
    },
  );

  it('treats the empty Compose value as unset', () => {
    const environment = {
      DATABASE_URL: 'postgresql://shelf@postgres/shelf',
      SHELF_STORAGE_DRIVER: 'r2',
      SHELF_R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      SHELF_R2_BUCKET: 'shelf-content',
      SHELF_R2_ACCESS_KEY_ID: 'access-key',
      SHELF_R2_SECRET_ACCESS_KEY: 'secret-key',
    };
    expect(
      shelfPersistenceConfigFromEnv({ ...environment, SHELF_STORAGE_CACHE_BYTES: '' }),
    ).toEqual(shelfPersistenceConfigFromEnv(environment));
    expect(shelfPersistenceConfigFromEnv(environment).content).not.toHaveProperty('cacheBytes');
  });
});
