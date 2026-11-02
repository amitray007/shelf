import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearPersistedContent,
  forgetPersistedContent,
  MAX_PERSISTED_ENTRIES,
  MAX_PERSISTED_ENTRY_BYTES,
  PERSISTED_CONTENT_TTL_MS,
  persistContent,
  readPersistedContent,
} from '../src/persistent-content.js';

/** Enough of Cache Storage for the module: string keys, cloned responses. */
function memoryCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const cacheFor = (entries: Map<string, Response>): Cache =>
    ({
      match: async (request: RequestInfo) => entries.get(String(request))?.clone(),
      put: async (request: RequestInfo, response: Response) => {
        entries.set(String(request), response.clone());
      },
      delete: async (request: RequestInfo | Request) =>
        entries.delete(typeof request === 'string' ? request : (request as Request).url),
      keys: async () => [...entries.keys()].map((url) => new Request(url)),
    }) as unknown as Cache;
  return {
    stores,
    storage: {
      open: async (name: string) => {
        let entries = stores.get(name);
        if (entries === undefined) {
          entries = new Map();
          stores.set(name, entries);
        }
        return cacheFor(entries);
      },
      delete: async (name: string) => stores.delete(name),
    } as unknown as CacheStorage,
  };
}

const key = (accessScope: string, folderPath = '') => ({
  accessScope,
  revisionId: `rev_${'c'.repeat(22)}`,
  folderPath,
});

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const text = (buffer: ArrayBuffer | undefined) =>
  buffer === undefined ? undefined : new TextDecoder().decode(buffer);

describe('persisted viewer content', () => {
  beforeEach(async () => {
    vi.stubGlobal('caches', memoryCacheStorage().storage);
    await clearPersistedContent();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns stored bytes for the same scope, revision, and path only', async () => {
    await persistContent(key('public:AbCdEf0123_-', 'docs/a.md'), bytes('hello'));
    expect(text(await readPersistedContent(key('public:AbCdEf0123_-', 'docs/a.md')))).toBe('hello');
    expect(await readPersistedContent(key('public:AbCdEf0123_-', 'docs/b.md'))).toBeUndefined();
    expect(await readPersistedContent(key('public:ZZZZZZZZZZZZ', 'docs/a.md'))).toBeUndefined();
  });

  it('expires old entries and skips oversized ones', async () => {
    await persistContent(key('public:AbCdEf0123_-'), bytes('old'), 0);
    expect(
      await readPersistedContent(key('public:AbCdEf0123_-'), PERSISTED_CONTENT_TTL_MS + 1),
    ).toBeUndefined();
    await persistContent(key('public:big'), new ArrayBuffer(MAX_PERSISTED_ENTRY_BYTES + 1));
    expect(await readPersistedContent(key('public:big'))).toBeUndefined();
  });

  it('keeps only the newest entries', async () => {
    for (let index = 0; index <= MAX_PERSISTED_ENTRIES; index += 1)
      await persistContent(key('public:AbCdEf0123_-', `f${index}`), bytes(`${index}`), index + 1);
    expect(await readPersistedContent(key('public:AbCdEf0123_-', 'f0'), 2)).toBeUndefined();
    expect(
      text(
        await readPersistedContent(
          key('public:AbCdEf0123_-', `f${MAX_PERSISTED_ENTRIES}`),
          MAX_PERSISTED_ENTRIES + 1,
        ),
      ),
    ).toBe(`${MAX_PERSISTED_ENTRIES}`);
  });

  it('forgets one share link without touching another', async () => {
    const shareId = `shr_${'a'.repeat(22)}`;
    await persistContent(key(`protected:${shareId}:session-1`), bytes('protected'));
    await persistContent(key('public:AbCdEf0123_-'), bytes('public'));
    await forgetPersistedContent(`protected:${shareId}:`);
    expect(await readPersistedContent(key(`protected:${shareId}:session-1`))).toBeUndefined();
    expect(text(await readPersistedContent(key('public:AbCdEf0123_-')))).toBe('public');
  });

  it('does nothing where Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    await clearPersistedContent();
    await persistContent(key('public:AbCdEf0123_-'), bytes('x'));
    expect(await readPersistedContent(key('public:AbCdEf0123_-'))).toBeUndefined();
  });
});

describe('viewer return visits', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('opens a revisited revision from this device without downloading it again', async () => {
    vi.stubGlobal('caches', memoryCacheStorage().storage);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('report bytes'));
    vi.stubGlobal('fetch', fetch);
    const shareId = `shr_${'a'.repeat(22)}`;
    const authority = {
      accessType: 'protected' as const,
      shareId,
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      token: `${'v'.repeat(24)}.${'s'.repeat(43)}`,
    };
    const file = {
      apiVersion: 'v1',
      shareId,
      accessType: 'protected',
      target: { mode: 'latest' },
      expiresAt: null,
      artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'report' },
      revision: {
        revisionId: `rev_${'c'.repeat(22)}`,
        revisionNumber: 1,
        createdAt: '2026-08-18T12:00:00.000Z',
        kind: 'file',
        byteCount: 12,
        mediaType: 'text/plain',
        originalFileName: 'report.txt',
      },
      action: { type: 'content', path: `/api/v1/public/shares/${shareId}/content` },
    } as const;

    const firstVisit = await import('../src/api.js');
    expect(text(await firstVisit.loadViewerFileBytes(file, authority))).toBe('report bytes');
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () =>
      expect(
        await readPersistedContent(key(`protected:${shareId}:${authority.sessionId}`)),
      ).toBeDefined(),
    );

    vi.resetModules();
    const secondVisit = await import('../src/api.js');
    expect(text(await secondVisit.loadViewerFileBytes(file, authority))).toBe('report bytes');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
