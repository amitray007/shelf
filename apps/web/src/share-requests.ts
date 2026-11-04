import {
  captureShareCapability,
  protectedSessionStorage,
  readOrCreateProtectedSessionId,
  readProtectedViewerToken,
  shareReferenceFromViewerPath,
} from './capability.js';

/**
 * The first share requests, built in one place so the early boot script and the viewer send
 * byte-identical requests. This module stays tiny: it runs before the main bundle arrives.
 */
export interface ShareRequest {
  readonly url: string;
  readonly init: RequestInit;
}

const anonymous = {
  cache: 'no-store',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
} as const;

export function protectedSessionRequest(
  shareId: string,
  sessionId: string,
  authority: { readonly secret: string } | { readonly token: string },
  signal?: AbortSignal,
): ShareRequest {
  return {
    url: `/api/v1/public/shares/${encodeURIComponent(shareId)}/sessions`,
    init: {
      ...anonymous,
      credentials: 'include',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Shelf-Inline-Content': 'true' },
      body: JSON.stringify({ sessionId, ...authority }),
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

export function publicResolveRequest(
  publicCode: string,
  revisionId?: string,
  signal?: AbortSignal,
): ShareRequest {
  const query = revisionId === undefined ? '' : `?${new URLSearchParams({ revisionId })}`;
  return {
    url: `/api/v1/public/links/${encodeURIComponent(publicCode)}/resolve${query}`,
    init: {
      ...anonymous,
      method: 'GET',
      headers: { 'X-Shelf-Inline-Content': 'true' },
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

// Long enough for a slow link to deliver the main bundle, short enough that a later
// navigation never adopts a stale answer.
const PREFETCH_TTL_MS = 30_000;

interface PrefetchStore {
  started: boolean;
  readonly responses: Map<string, { readonly response: Promise<Response>; readonly at: number }>;
}

// The early script is its own bundle, so this module has two instances on a share page. They
// meet in one global store, which also stops the main bundle from sending the requests twice.
const STORE_KEY = Symbol.for('shelf.share-prefetch');
function store(): PrefetchStore {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: PrefetchStore };
  holder[STORE_KEY] ??= { started: false, responses: new Map() };
  return holder[STORE_KEY];
}

function requestKey(url: string, init: RequestInit): string {
  return `${init.method ?? 'GET'} ${url} ${typeof init.body === 'string' ? init.body : ''}`;
}

/**
 * Hand an early response to the identical request, once. The caller still validates it; a
 * missing, expired, or failed early request just means the caller sends its own.
 */
export function takePrefetchedResponse(
  url: string,
  init: RequestInit,
): Promise<Response> | undefined {
  const key = requestKey(url, init);
  const { responses } = store();
  const entry = responses.get(key);
  if (entry === undefined) return undefined;
  responses.delete(key);
  return Date.now() - entry.at > PREFETCH_TTL_MS ? undefined : entry.response;
}

function prefetch(request: ShareRequest): void {
  try {
    const response = fetch(request.url, request.init);
    void response.catch(() => undefined);
    store().responses.set(requestKey(request.url, request.init), { response, at: Date.now() });
  } catch {
    // The viewer sends the request itself.
  }
}

/**
 * Send the request the viewer's first step will make, mirroring its choices exactly: a stored
 * Protected token first, otherwise the link secret from this tab; the Public lookup otherwise.
 */
export function prefetchShareOpen(): void {
  if (typeof window === 'undefined' || typeof window.location?.href !== 'string') return;
  const state = store();
  if (state.started) return;
  state.started = true;
  try {
    const url = new URL(window.location.href);
    const reference = shareReferenceFromViewerPath(url.pathname);
    if (reference === null) return;
    if (reference.accessType === 'public') {
      prefetch(
        publicResolveRequest(reference.publicCode, url.searchParams.get('revision') ?? undefined),
      );
      return;
    }
    const durable = protectedSessionStorage();
    const token = readProtectedViewerToken(reference.shareId, durable);
    if (token !== null) {
      const sessionId = readOrCreateProtectedSessionId(reference.shareId, durable);
      if (sessionId !== null)
        prefetch(protectedSessionRequest(reference.shareId, sessionId, { token }));
      return;
    }
    const secret = captureShareCapability({
      shareId: reference.shareId,
      location: window.location,
      history: window.history,
      sessionStorage: window.sessionStorage,
    });
    if (secret === null) return;
    const sessionId = readOrCreateProtectedSessionId(reference.shareId, durable);
    if (sessionId !== null)
      prefetch(protectedSessionRequest(reference.shareId, sessionId, { secret }));
  } catch {
    // Storage or history refused: the viewer handles this path with its own errors.
  }
}

/** Test seam: forget early responses and allow another start. */
export function resetSharePrefetch(): void {
  const state = store();
  state.responses.clear();
  state.started = false;
}
