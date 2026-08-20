import { describe, expect, it } from 'vitest';

import { ContentCache, type ContentCacheKey } from '../src/content-cache.js';

const key = (folderPath: string, accessScope = 'public:pub_test'): ContentCacheKey => ({
  accessScope,
  revisionId: 'rev_test',
  folderPath,
});

function bytes(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('ContentCache', () => {
  it('deduplicates misses and returns copies on hits', async () => {
    const cache = new ContentCache({ maxBytes: 100, maxEntries: 10 });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return bytes('hello');
    };

    const first = await cache.getOrLoad(key('a.md'), load);
    new Uint8Array(first)[0] = 'x'.charCodeAt(0);
    const second = await cache.getOrLoad(key('a.md'), load);

    expect(loads).toBe(1);
    expect(new TextDecoder().decode(second)).toBe('hello');
    expect(cache.size).toBe(1);
  });

  it('shares one in-flight load without sharing consumer cancellation', async () => {
    const cache = new ContentCache({ maxBytes: 100, maxEntries: 10 });
    const result = deferred<ArrayBuffer>();
    let loads = 0;
    let sharedSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal) => {
      loads += 1;
      sharedSignal = signal;
      return result.promise;
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = cache.getOrLoad(key('a.md'), load, firstController.signal);
    const second = cache.getOrLoad(key('a.md'), load, secondController.signal);
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(sharedSignal?.aborted).toBe(false);
    result.resolve(bytes('shared'));
    expect(new TextDecoder().decode(await second)).toBe('shared');
    expect(loads).toBe(1);
  });

  it('evicts least-recently-used entries by entry and byte bounds', async () => {
    const cache = new ContentCache({ maxBytes: 4, maxEntries: 2 });
    const loads = new Map<string, number>();
    const load = async (_signal: AbortSignal, path: string) => {
      loads.set(path, (loads.get(path) ?? 0) + 1);
      return bytes(path);
    };

    await cache.getOrLoad(key('a'), (signal) => load(signal, 'aa'));
    await cache.getOrLoad(key('b'), (signal) => load(signal, 'bb'));
    await cache.getOrLoad(key('a'), (signal) => load(signal, 'aa'));
    expect(loads.get('aa')).toBe(1);
    await cache.getOrLoad(key('c'), (signal) => load(signal, 'cc'));
    await cache.getOrLoad(key('b'), (signal) => load(signal, 'bb'));
    expect(loads.get('bb')).toBe(2);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(4);
  });

  it('does not cache failures, oversized content, or a fully aborted load', async () => {
    const cache = new ContentCache({ maxBytes: 3, maxEntries: 2 });
    let failures = 0;
    const failingLoad = async () => {
      failures += 1;
      throw new Error('nope');
    };
    await expect(cache.getOrLoad(key('failed'), failingLoad)).rejects.toThrow('nope');
    await expect(cache.getOrLoad(key('failed'), failingLoad)).rejects.toThrow('nope');
    expect(failures).toBe(2);

    await cache.getOrLoad(key('large'), async () => bytes('1234'));
    expect(cache.size).toBe(0);

    const pending = deferred<ArrayBuffer>();
    let loadSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const request = cache.getOrLoad(
      key('aborted'),
      (signal) => {
        loadSignal = signal;
        return pending.promise;
      },
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(loadSignal?.aborted).toBe(true);
    pending.resolve(bytes('late'));
    await Promise.resolve();
    await expect(cache.getOrLoad(key('aborted'), async () => bytes('fresh'))).resolves.toEqual(
      bytes('fresh'),
    );
  });

  it('partitions identical paths by access scope and revision', async () => {
    const cache = new ContentCache({ maxBytes: 100, maxEntries: 10 });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return bytes(String(loads));
    };
    await cache.getOrLoad(key('same', 'public:first'), load);
    await cache.getOrLoad(key('same', 'protected:share:session'), load);
    await cache.getOrLoad({ ...key('same'), revisionId: 'rev_other' }, load);
    expect(loads).toBe(3);
  });
});
