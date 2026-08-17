import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
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
  it('seals and reads an empty immutable object for complete folder snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-local-zero-byte-'));
    roots.push(root);
    const storage = new LocalContentStorage({ root });
    const staged = await storage.stage((async function* empty() {})(), {});
    const descriptor = {
      contentHash: `sha256:${createHash('sha256').update('').digest('hex')}`,
      byteCount: 0,
    };
    const sealed = await storage.seal(staged, descriptor);
    const chunks: Uint8Array[] = [];
    for await (const chunk of await storage.read(sealed, {})) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(0));
    await expect(storage.read(sealed, { range: { start: 0, end: 0 } })).rejects.toThrow(
      'Invalid content byte range',
    );
  });

  it('inventories an uninitialized root as empty without creating it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'shelf-local-empty-'));
    const root = join(parent, 'content');
    roots.push(parent);
    const storage = new LocalContentStorage({ root });

    await expect(storage.inventory()).resolves.toEqual({
      staging: [],
      sealed: [],
      unrecognizedEntries: 0,
    });
    await expect(readdir(parent)).resolves.toEqual([]);
  });

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

  it('inventories staging and sealed objects without modifying storage', async () => {
    const { root, storage } = await fixture();
    const staged = await storage.stage(chunks('stage'), {});
    const toSeal = await storage.stage(chunks('sealed'), {});
    const sealed = await storage.seal(toSeal, descriptor('sealed'));
    const modifiedAt = new Date('2026-08-16T10:00:00.000Z');
    await Promise.all([
      utimes(join(root, 'staging', `${staged.stageId}.stage`), modifiedAt, modifiedAt),
      utimes(join(root, 'objects', sealed.contentId), modifiedAt, modifiedAt),
      writeFile(join(root, 'objects', 'unexpected-entry'), 'unknown'),
    ]);

    await expect(storage.inventory()).resolves.toEqual({
      staging: [{ stageId: staged.stageId, modifiedAt }],
      sealed: [{ contentId: sealed.contentId, byteCount: 6, modifiedAt }],
      unrecognizedEntries: 1,
    });
    await expect(readdir(join(root, 'staging'))).resolves.toEqual([`${staged.stageId}.stage`]);
    await expect(readdir(join(root, 'objects'))).resolves.toEqual(
      expect.arrayContaining([sealed.contentId, 'unexpected-entry']),
    );
  });
});
