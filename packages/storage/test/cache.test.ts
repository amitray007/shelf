import type { ContentReader, SealedContent } from '@shelf/core';
import { describe, expect, it, vi } from 'vitest';

import { CachedContentReader, ContentByteCache } from '../src/index.js';

function descriptor(id = 1, byteCount = 8, hash = 'a'): SealedContent {
  return {
    contentId: `cnt_${id.toString(16).padStart(32, '0')}`,
    contentHash: `sha256:${hash.repeat(64)}`,
    byteCount,
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function fixture(limit = 64) {
  const read = vi.fn<ContentReader['read']>(async (content, options) => {
    const bytes = Buffer.from('abcdefgh'.repeat(Math.ceil(content.byteCount / 8))).subarray(
      0,
      content.byteCount,
    );
    return [
      options.range === undefined
        ? bytes
        : bytes.subarray(options.range.start, options.range.end + 1),
    ];
  });
  return { read, reader: new CachedContentReader({ read }, new ContentByteCache(limit)) };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('CachedContentReader', () => {
  it('loads once for a cold range and serves full and exact ranges from the same bytes', async () => {
    const { read, reader } = fixture();
    expect(await collect(await reader.read(descriptor(), { range: { start: 2, end: 4 } }))).toBe(
      'cde',
    );
    expect(read.mock.calls[0]?.[1].range).toBeUndefined();
    expect(await collect(await reader.read(descriptor(), {}))).toBe('abcdefgh');
    expect(await collect(await reader.read(descriptor(), { range: { start: 7, end: 7 } }))).toBe(
      'h',
    );
    expect(read).toHaveBeenCalledTimes(1);
    await expect(reader.read(descriptor(), { range: { start: 8, end: 8 } })).rejects.toThrow(
      'range',
    );
    await expect(reader.read(descriptor(1, 7), {})).rejects.toThrow('size mismatch');
  });

  it('keys by both immutable identity fields and never exposes mutable cache bytes', async () => {
    const { read, reader } = fixture();
    const stream = await reader.read(descriptor(), {});
    for await (const chunk of stream) chunk.fill(0);
    expect(await collect(await reader.read(descriptor(), {}))).toBe('abcdefgh');
    expect(await collect(await reader.read(descriptor(1, 8, 'b'), {}))).toBe('abcdefgh');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used bytes within its budget', async () => {
    const { read, reader } = fixture();
    for (let id = 1; id <= 8; id += 1) await collect(await reader.read(descriptor(id), {}));
    await collect(await reader.read(descriptor(1), {}));
    await collect(await reader.read(descriptor(9), {}));
    await collect(await reader.read(descriptor(1), {}));
    expect(read).toHaveBeenCalledTimes(9);
    await collect(await reader.read(descriptor(2), {}));
    expect(read).toHaveBeenCalledTimes(10);
  });

  it('bypasses oversize objects without fetching a whole object for a cold range', async () => {
    const { read, reader } = fixture();
    const options = { range: { start: 1, end: 3 } };
    expect(await collect(await reader.read(descriptor(1, 9), options))).toBe('bcd');
    expect(await collect(await reader.read(descriptor(1, 9), options))).toBe('bcd');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]).toBe(options);
  });

  it('passes every read through when disabled', async () => {
    const { read, reader } = fixture(0);
    await collect(await reader.read(descriptor(), {}));
    await collect(await reader.read(descriptor(), {}));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('coalesces full and range misses while isolating one caller abort', async () => {
    const gate = deferred();
    const read = vi.fn<ContentReader['read']>(async () =>
      (async function* () {
        await gate.promise;
        yield Buffer.from('abcdefgh');
      })(),
    );
    const reader = new CachedContentReader({ read }, new ContentByteCache(64));
    const controller = new AbortController();
    const first = reader.read(descriptor(), { signal: controller.signal });
    const rejected = expect(first).rejects.toThrow('cancel first');
    const second = reader.read(descriptor(), { range: { start: 2, end: 4 } });
    controller.abort(new Error('cancel first'));
    await rejected;
    expect(read.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    gate.resolve();
    expect(await collect(await second)).toBe('cde');
    expect(await collect(await reader.read(descriptor(), {}))).toBe('abcdefgh');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('bypasses a new fill when the budget is reserved by concurrent reads', async () => {
    const gate = deferred();
    const read = vi.fn<ContentReader['read']>(async (_content, options) =>
      (async function* () {
        await gate.promise;
        const bytes = Buffer.from('abcdefgh');
        yield options.range === undefined
          ? bytes
          : bytes.subarray(options.range.start, options.range.end + 1);
      })(),
    );
    const reader = new CachedContentReader({ read }, new ContentByteCache(64));
    const fills = Array.from({ length: 8 }, (_, index) => reader.read(descriptor(index + 1), {}));
    const options = { range: { start: 1, end: 2 } };
    const bypass = await reader.read(descriptor(9), options);
    expect(read.mock.calls[8]?.[1]).toBe(options);
    gate.resolve();
    expect(await collect(bypass)).toBe('bc');
    for (const fill of fills) expect(await collect(await fill)).toBe('abcdefgh');
    expect(await collect(await reader.read(descriptor(9), {}))).toBe('abcdefgh');
    expect(read).toHaveBeenCalledTimes(10);
  });

  it('rejects a conflicting size on a coalesced read', async () => {
    const gate = deferred();
    const read: ContentReader['read'] = async () =>
      (async function* () {
        await gate.promise;
        yield Buffer.from('abcdefgh');
      })();
    const reader = new CachedContentReader({ read }, new ContentByteCache(64));
    const first = reader.read(descriptor(), {});
    const second = reader.read(descriptor(1, 7), {});
    const rejected = expect(second).rejects.toThrow('size mismatch');
    gate.resolve();
    expect(await collect(await first)).toBe('abcdefgh');
    await rejected;
  });

  it('cancels a fill when all callers abort and never caches its late completion', async () => {
    const gate = deferred();
    const read = vi.fn<ContentReader['read']>(async () =>
      (async function* () {
        await gate.promise;
        yield Buffer.from('abcdefgh');
      })(),
    );
    const reader = new CachedContentReader({ read }, new ContentByteCache(64));
    const controller = new AbortController();
    const result = reader.read(descriptor(), { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('cancel all');
    controller.abort(new Error('cancel all'));
    await rejected;
    expect(read.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    gate.resolve();
    expect(await collect(await reader.read(descriptor(), {}))).toBe('abcdefgh');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'short', 'long'])('does not cache a %s read', async (failure) => {
    const { read, reader } = fixture();
    read.mockImplementationOnce(async () =>
      (async function* () {
        yield Buffer.from(failure === 'short' ? 'abc' : failure === 'long' ? 'abcdefghijk' : 'ab');
        if (failure === 'error') throw new Error('broken stream');
      })(),
    );
    await expect(reader.read(descriptor(), {})).rejects.toThrow();
    expect(await collect(await reader.read(descriptor(), {}))).toBe('abcdefgh');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('handles empty objects and rejects invalid empty ranges without a provider call', async () => {
    const { read, reader } = fixture();
    expect(await collect(await reader.read(descriptor(1, 0), {}))).toBe('');
    expect(await collect(await reader.read(descriptor(1, 0), {}))).toBe('');
    await expect(reader.read(descriptor(1, 0), { range: { start: 0, end: 0 } })).rejects.toThrow(
      'range',
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rejects an already aborted hit and an abort before stream consumption', async () => {
    const { read, reader } = fixture();
    await collect(await reader.read(descriptor(), {}));
    const controller = new AbortController();
    const source = await reader.read(descriptor(), { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(collect(source)).rejects.toThrow('stop');
    await expect(reader.read(descriptor(), { signal: controller.signal })).rejects.toThrow('stop');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
