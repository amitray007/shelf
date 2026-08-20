export interface ContentCacheKey {
  readonly accessScope: string;
  readonly revisionId: string;
  readonly folderPath: string;
}

export interface ContentCacheOptions {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export type ContentLoader = (signal: AbortSignal) => Promise<ArrayBuffer>;

interface CachedContent {
  readonly bytes: ArrayBuffer;
  readonly byteLength: number;
}

interface InFlightContent {
  readonly key: string;
  readonly controller: AbortController;
  consumers: number;
  promise: Promise<ArrayBuffer>;
}

function cacheKey(key: ContentCacheKey): string {
  return JSON.stringify([key.accessScope, key.revisionId, key.folderPath]);
}

function copyBytes(bytes: ArrayBuffer): ArrayBuffer {
  return bytes.slice(0);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

/** A bounded, scope-partitioned cache for immutable ArrayBuffer content. */
export class ContentCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CachedContent>();
  private readonly inFlight = new Map<string, InFlightContent>();
  private totalBytes = 0;

  constructor(options: ContentCacheOptions) {
    if (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive integer');
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxBytes = options.maxBytes;
    this.maxEntries = options.maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  async getOrLoad(
    key: ContentCacheKey,
    loader: ContentLoader,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    throwIfAborted(signal);
    const serializedKey = cacheKey(key);
    const cached = this.entries.get(serializedKey);
    if (cached !== undefined) {
      // Map insertion order is the recency order used by the LRU.
      this.entries.delete(serializedKey);
      this.entries.set(serializedKey, cached);
      return copyBytes(cached.bytes);
    }

    let pending = this.inFlight.get(serializedKey);
    if (pending === undefined) {
      const controller = new AbortController();
      pending = {
        key: serializedKey,
        controller,
        consumers: 0,
        promise: Promise.resolve(undefined as never),
      };
      pending.promise = loader(controller.signal).then((bytes) => {
        // A load abandoned by every consumer must not become a cached result,
        // even when an adapter resolves after receiving the abort signal.
        if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
        const stored = copyBytes(bytes);
        this.store(serializedKey, stored);
        return stored;
      });
      this.inFlight.set(serializedKey, pending);
      void pending.promise.then(
        () => {
          if (this.inFlight.get(serializedKey) === pending) this.inFlight.delete(serializedKey);
        },
        () => {
          if (this.inFlight.get(serializedKey) === pending) this.inFlight.delete(serializedKey);
        },
      );
    }

    pending.consumers += 1;
    return this.consume(pending, signal);
  }

  private async consume(pending: InFlightContent, signal?: AbortSignal): Promise<ArrayBuffer> {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      pending.consumers -= 1;
      if (pending.consumers === 0 && !pending.controller.signal.aborted) {
        pending.controller.abort();
        if (this.inFlight.get(pending.key) === pending) this.inFlight.delete(pending.key);
      }
    };

    if (signal?.aborted) {
      release();
      throw signal.reason ?? abortError();
    }
    if (signal === undefined) {
      try {
        return copyBytes(await pending.promise);
      } finally {
        release();
      }
    }

    return new Promise<ArrayBuffer>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        release();
        reject(signal.reason ?? abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (bytes) => {
          signal.removeEventListener('abort', onAbort);
          release();
          resolve(copyBytes(bytes));
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          release();
          reject(error);
        },
      );
    });
  }

  private store(serializedKey: string, bytes: ArrayBuffer): void {
    if (bytes.byteLength > this.maxBytes) return;
    const previous = this.entries.get(serializedKey);
    if (previous !== undefined) this.totalBytes -= previous.byteLength;
    this.entries.delete(serializedKey);
    this.entries.set(serializedKey, { bytes, byteLength: bytes.byteLength });
    this.totalBytes += bytes.byteLength;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const removed = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (removed !== undefined) this.totalBytes -= removed.byteLength;
    }
  }
}
