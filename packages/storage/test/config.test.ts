import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createContentStorage, LocalContentStorage, S3ContentStorage } from '../src/index.js';

describe('createContentStorage', () => {
  it('selects local or Cloudflare R2 without changing the storage interface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-storage-config-'));
    try {
      expect(createContentStorage({ driver: 'local', root })).toBeInstanceOf(LocalContentStorage);
      expect(
        createContentStorage({
          driver: 'r2',
          accountId: '0123456789abcdef0123456789abcdef',
          bucket: 'shelf-content',
          accessKeyId: 'access-key',
          secretAccessKey: 'secret-key',
        }),
      ).toBeInstanceOf(S3ContentStorage);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects malformed R2 configuration before making a storage request', () => {
    expect(() =>
      createContentStorage({
        driver: 'r2',
        accountId: 'not-an-account-id',
        bucket: 'shelf-content',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      }),
    ).toThrow('accountId');
  });
});
