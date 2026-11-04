import { afterEach, describe, expect, it, vi } from 'vitest';

import { establishProtectedSession, resolveViewerShare } from '../src/api.js';
import {
  prefetchShareOpen,
  resetSharePrefetch,
  takePrefetchedResponse,
} from '../src/share-requests.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const PUBLIC_CODE = 'AbCdEf0123_-';
const SECRET = 'S'.repeat(43);
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function stubWindow(href: string, localStorage = memoryStorage()) {
  const url = new URL(href);
  const history = { state: null, replaceState: vi.fn() };
  vi.stubGlobal('window', {
    location: { href, pathname: url.pathname, search: url.search, hash: url.hash },
    history,
    localStorage,
    sessionStorage: memoryStorage(),
  });
  return history;
}

afterEach(() => {
  resetSharePrefetch();
  vi.unstubAllGlobals();
});

describe('early share requests', () => {
  it('sends the Public lookup once and hands it to the identical viewer request', async () => {
    stubWindow(`https://shelf.example/s/${PUBLIC_CODE}?revision=rev_${'c'.repeat(22)}`);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    prefetchShareOpen();
    prefetchShareOpen();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/v1/public/links/${PUBLIC_CODE}/resolve?revisionId=rev_${'c'.repeat(22)}`,
    );
    expect(init?.credentials).toBe('omit');
    expect(takePrefetchedResponse(String(url), { ...init, method: 'GET' })).toBeDefined();
    expect(takePrefetchedResponse(String(url), { ...init, method: 'GET' })).toBeUndefined();
  });

  it('lets the viewer adopt the early Protected session instead of sending another', async () => {
    const history = stubWindow(`https://shelf.example/s/${SHARE_ID}#${SECRET}`);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        apiVersion: 'v1',
        shareId: SHARE_ID,
        sessionId: SESSION_ID,
        token: `${'v'.repeat(24)}.${'s'.repeat(43)}`,
        issuedAt: '2026-11-04T00:00:00.000Z',
        expiresAt: '2026-11-05T00:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('crypto', { randomUUID: () => SESSION_ID });
    prefetchShareOpen();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', `/s/${SHARE_ID}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: SESSION_ID,
      secret: SECRET,
    });
    const established = await establishProtectedSession(SHARE_ID, SESSION_ID, {
      secret: SECRET,
    });
    expect(established.sessionId).toBe(SESSION_ID);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sends the request itself when the early one failed', async () => {
    stubWindow(`https://shelf.example/s/${PUBLIC_CODE}`);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    prefetchShareOpen();
    await expect(
      resolveViewerShare(
        { accessType: 'public', publicCode: PUBLIC_CODE },
        { accessType: 'public', publicCode: PUBLIC_CODE },
      ),
    ).rejects.toThrow();
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing outside a share route', () => {
    stubWindow('https://shelf.example/app/artifacts');
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    prefetchShareOpen();
    expect(fetch).not.toHaveBeenCalled();
  });
});
