import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { ContentByteCache, S3ContentStorage } from '../src/index.js';

function fixture(cacheBytes = 64) {
  let gets = 0;
  let failSeal = false;
  const objects = new Map<string, Buffer>();
  const client = new S3Client({
    region: 'auto',
    endpoint: 'https://storage.test',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    requestHandler: {
      async handle(request: {
        method: string;
        path: string;
        body?: unknown;
        headers: Record<string, string>;
      }) {
        const key = request.path;
        if (request.method === 'PUT') {
          const chunks: Uint8Array[] = [];
          if (request.body instanceof Uint8Array) {
            chunks.push(request.body);
          } else {
            for await (const chunk of request.body as AsyncIterable<Uint8Array>) chunks.push(chunk);
          }
          objects.set(key, Buffer.concat(chunks));
          return { response: { statusCode: 200, headers: { etag: '"ok"' } } };
        }
        if (request.method === 'HEAD') {
          return {
            response: {
              statusCode: failSeal ? 500 : 200,
              headers: { 'content-length': String(objects.get(key)?.length ?? 0) },
            },
          };
        }
        if (request.method === 'DELETE') {
          objects.delete(key);
          return { response: { statusCode: 204, headers: {} } };
        }
        gets += 1;
        const body = objects.get(key);
        if (body === undefined) return { response: { statusCode: 404, headers: {} } };
        const range = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '');
        const selected =
          range === null ? body : body.subarray(Number(range[1]), Number(range[2]) + 1);
        return {
          response: {
            statusCode: range === null ? 200 : 206,
            headers: {
              'content-length': String(selected.length),
              ...(range === null
                ? {}
                : { 'content-range': `bytes ${range[1]}-${range[2]}/${body.length}` }),
            },
            body: Readable.from([selected]),
          },
        };
      },
    },
  });
  const cache = new ContentByteCache(cacheBytes);
  const storage = new S3ContentStorage({ client, bucket: 'test-bucket', cache });
  return {
    storage,
    cache,
    gets: () => gets,
    failSeal: (value: boolean) => {
      failSeal = value;
    },
  };
}

const hash = `sha256:${'a'.repeat(64)}`;
async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function* chunks(value: string) {
  for (const character of value) yield Buffer.from(character);
}

describe('R2 seal write-through', () => {
  it('warms the first open for each sealed folder entry, including empty entries', async () => {
    const { storage, gets } = fixture();
    for (const value of ['index', 'asset', '']) {
      const staged = await storage.stage(chunks(value), {});
      const sealed = await storage.seal(staged, { contentHash: hash, byteCount: value.length });
      expect(await collect(await storage.read(sealed, {}))).toBe(value);
    }
    expect(gets()).toBe(0);
    storage.close();
  });

  it('does not warm on a failed seal and drops the staged bytes', async () => {
    const { storage, gets, failSeal, cache } = fixture();
    const staged = await storage.stage(chunks('hello'), {});
    const descriptor = { contentHash: hash, byteCount: 5 };
    failSeal(true);
    await expect(storage.seal(staged, descriptor)).rejects.toThrow();
    expect(cache.get(`stage:${staged.stageId}`)).toBeUndefined();
    failSeal(false);
    const sealed = await storage.seal(staged, descriptor);
    expect(await collect(await storage.read(sealed, {}))).toBe('hello');
    expect(gets()).toBe(1);
    storage.close();
  });

  it('does not warm on a descriptor mismatch', async () => {
    const { storage, cache } = fixture();
    const staged = await storage.stage(chunks('hello'), {});
    await expect(storage.seal(staged, { contentHash: hash, byteCount: 4 })).rejects.toThrow(
      'size mismatch',
    );
    expect(cache.get(`stage:${staged.stageId}`)).toBeUndefined();
    storage.close();
  });

  it.each([0, 64])('keeps oversized uploads out of a %s byte cache', async (limit) => {
    const { storage, gets, cache } = fixture(limit);
    const staged = await storage.stage(chunks('0123456789'), {});
    expect(cache.get(`stage:${staged.stageId}`)).toBeUndefined();
    const sealed = await storage.seal(staged, { contentHash: hash, byteCount: 10 });
    expect(await collect(await storage.read(sealed, { range: { start: 1, end: 3 } }))).toBe('123');
    expect(gets()).toBe(1);
    storage.close();
  });

  it('does not retain a failed upload and removes discarded stages', async () => {
    const { storage, cache } = fixture();
    await expect(
      storage.stage(
        (async function* () {
          yield Buffer.from('abc');
          throw new Error('upload failed');
        })(),
        {},
      ),
    ).rejects.toThrow('upload failed');
    const staged = await storage.stage(chunks('hello'), {});
    expect(cache.get(`stage:${staged.stageId}`)?.toString()).toBe('hello');
    await storage.discard(staged);
    expect(cache.get(`stage:${staged.stageId}`)).toBeUndefined();
    storage.close();
  });

  it('invalidates cached content after a successful sealed delete', async () => {
    const { storage } = fixture();
    const staged = await storage.stage(chunks('hello'), {});
    const sealed = await storage.seal(staged, { contentHash: hash, byteCount: 5 });
    await storage.deleteSealed(sealed.contentId);
    await expect(storage.read(sealed, {})).rejects.toThrow();
    storage.close();
  });
});
