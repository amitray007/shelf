import type { ContentCacheKey } from './content-cache.js';

/**
 * A per-device copy of immutable share bytes, so a return visit on a slow link skips the
 * download. Revision content never changes, and every open resolves the share first, so these
 * bytes are only ever read after the server confirmed access in the same open. Revoked and
 * expired links therefore stay closed; their entries are also purged when that answer comes back.
 */
const CACHE_NAME = 'shelf-viewer-content-v1';
const KEY_PREFIX = '/__shelf/viewer-content/';
const STORED_AT = 'x-shelf-stored-at';
export const MAX_PERSISTED_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_PERSISTED_ENTRIES = 96;
export const PERSISTED_CONTENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function storage(): CacheStorage | undefined {
  try {
    // Cache Storage exists only in secure contexts and some private modes refuse it.
    return typeof caches === 'undefined' ? undefined : caches;
  } catch {
    return undefined;
  }
}

/** Lets callers start a download without an extra turn when there is nothing to consult. */
export function persistentContentAvailable(): boolean {
  return storage() !== undefined;
}

function origin(): string {
  return typeof location === 'undefined' ? 'https://shelf.invalid' : location.origin;
}

function scopePrefix(accessScope: string): string {
  return `${origin()}${KEY_PREFIX}${encodeURIComponent(accessScope)}/`;
}

function requestKey(key: ContentCacheKey): string {
  return `${scopePrefix(key.accessScope)}${encodeURIComponent(key.revisionId)}/${encodeURIComponent(
    key.folderPath,
  )}`;
}

let opening: Promise<Cache | undefined> | undefined;
function openCache(): Promise<Cache | undefined> {
  const store = storage();
  if (store === undefined) return Promise.resolve(undefined);
  opening ??= store.open(CACHE_NAME).catch(() => {
    opening = undefined;
    return undefined;
  });
  return opening;
}

/** Open storage while the share resolves, so a later lookup costs one match, not an open. */
export function warmPersistedContent(): void {
  void openCache();
}

export async function readPersistedContent(
  key: ContentCacheKey,
  now = Date.now(),
): Promise<ArrayBuffer | undefined> {
  try {
    const cache = await openCache();
    const response = await cache?.match(requestKey(key));
    if (response === undefined) return undefined;
    const storedAt = Number(response.headers.get(STORED_AT));
    if (!Number.isFinite(storedAt) || now - storedAt > PERSISTED_CONTENT_TTL_MS) {
      void cache?.delete(requestKey(key));
      return undefined;
    }
    return await response.arrayBuffer();
  } catch {
    return undefined;
  }
}

// Pruning scans every entry, so it runs on the first write and then every few writes.
const PRUNE_EVERY_WRITES = 8;
let writesSincePrune = 0;

async function prune(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  if (keys.length <= MAX_PERSISTED_ENTRIES) return;
  const dated = await Promise.all(
    keys.map(async (request) => ({
      request,
      storedAt: Number((await cache.match(request))?.headers.get(STORED_AT) ?? 0),
    })),
  );
  dated.sort((a, b) => a.storedAt - b.storedAt);
  await Promise.all(
    dated.slice(0, keys.length - MAX_PERSISTED_ENTRIES).map(({ request }) => cache.delete(request)),
  );
}

export async function persistContent(
  key: ContentCacheKey,
  bytes: ArrayBuffer,
  now = Date.now(),
): Promise<void> {
  if (bytes.byteLength > MAX_PERSISTED_ENTRY_BYTES) return;
  try {
    const cache = await openCache();
    if (cache === undefined) return;
    await cache.put(
      requestKey(key),
      new Response(bytes.slice(0), {
        headers: { 'content-type': 'application/octet-stream', [STORED_AT]: String(now) },
      }),
    );
    if (writesSincePrune === 0) await prune(cache);
    writesSincePrune = (writesSincePrune + 1) % PRUNE_EVERY_WRITES;
  } catch {
    // Quota and private-mode failures only cost the next visit a download.
  }
}

/** Store after the view has what it needs, so writing never competes with the first paint. */
export function schedulePersistContent(key: ContentCacheKey, bytes: ArrayBuffer): void {
  const write = () => void persistContent(key, bytes);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(write, { timeout: 2000 });
  else setTimeout(write, 0);
}

/** Drop every entry a share link stored, for example after the server says it is gone. */
export async function forgetPersistedContent(scopeStartsWith: string): Promise<void> {
  try {
    const cache = await openCache();
    if (cache === undefined) return;
    const prefix = scopePrefix(scopeStartsWith).slice(0, -1);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((request) => request.url.startsWith(prefix))
        .map((request) => cache.delete(request)),
    );
  } catch {
    // Nothing to forget when storage is unavailable.
  }
}

export async function clearPersistedContent(): Promise<void> {
  opening = undefined;
  writesSincePrune = 0;
  try {
    await storage()?.delete(CACHE_NAME);
  } catch {
    // Unavailable storage holds nothing.
  }
}
