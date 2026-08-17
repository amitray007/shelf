import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalContentStorage } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{ root: string; storage: LocalContentStorage }> {
  const root = await mkdtemp(join(tmpdir(), 'shelf-local-storage-'));
  roots.push(root);
  return { root, storage: new LocalContentStorage({ root }) };
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const collected: Uint8Array[] = [];
  for await (const chunk of source) collected.push(chunk);
  return Buffer.concat(collected).toString('utf8');
}

function descriptor(value: string) {
  return {
    contentHash: `sha256:${createHash('sha256').update(value).digest('hex')}`,
    byteCount: Buffer.byteLength(value),
  };
}

describe('LocalContentStorage', () => {
  it('initializes and verifies a writable durable root without leaving probe content', async () => {
    const { root, storage } = await fixture();
    await storage.ready();
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([]);
    await expect(readdir(join(root, 'objects'))).resolves.toEqual([]);
  });

  it('seals immutable bytes and serves full and ranged reads through the storage interface', async () => {
    const { storage } = await fixture();
    const staged = await storage.stage(chunks('hello ', 'shelf'), {});
    const sealed = await storage.seal(staged, descriptor('hello shelf'));

    expect(sealed).toMatchObject({
      contentId: expect.stringMatching(/^cnt_[a-f0-9]{32}$/u),
      ...descriptor('hello shelf'),
    });
    await expect(collect(await storage.read(sealed, {}))).resolves.toBe('hello shelf');
    await expect(
      collect(await storage.read(sealed, { range: { start: 6, end: 10 } })),
    ).resolves.toBe('shelf');
  });

  it('removes partial staging when the caller cancels', async () => {
    const { root, storage } = await fixture();
    const controller = new AbortController();
    const content = (async function* upload() {
      yield Buffer.from('first');
      controller.abort(new Error('cancelled'));
      yield Buffer.from('second');
    })();

    await expect(storage.stage(content, { signal: controller.signal })).rejects.toThrow();
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([]);
  });

  it('does not seal content whose persisted size disagrees with its descriptor', async () => {
    const { root, storage } = await fixture();
    const staged = await storage.stage(chunks('hello'), {});

    await expect(storage.seal(staged, { ...descriptor('hello'), byteCount: 6 })).rejects.toThrow(
      'size mismatch',
    );
    await storage.discard(staged);
    await expect(readdir(join(root, 'objects'))).resolves.toEqual([]);
  });
});
