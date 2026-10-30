import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { createContentStorage } from '../src/index.js';

const config = {
  driver: 'r2' as const,
  accountId: '0123456789abcdef0123456789abcdef',
  bucket: 'shelf-content',
  accessKeyId: 'access-key',
  secretAccessKey: 'secret-key',
};
const content = {
  contentId: `cnt_${'1'.repeat(32)}`,
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteCount: 8,
};

async function readTwice(cacheBytes?: number) {
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
    ContentLength: 8,
    Body: Readable.from([Buffer.from('abcdefgh')]),
  }));
  const storage = createContentStorage({
    ...config,
    ...(cacheBytes === undefined ? {} : { cacheBytes }),
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of await storage.read(content, {})) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('abcdefgh');
    }
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    return send.mock.calls.length;
  } finally {
    storage.close?.();
    send.mockRestore();
  }
}

describe('R2 factory cache configuration', () => {
  it.each([undefined, 64])('wires a cache with budget %s', async (cacheBytes) => {
    expect(await readTwice(cacheBytes)).toBe(1);
  });

  it('disables caching with a zero-byte budget', async () => {
    expect(await readTwice(0)).toBe(2);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cache budget %s',
    (cacheBytes) => {
      expect(() => createContentStorage({ ...config, cacheBytes })).toThrow('cache bytes');
    },
  );
});
