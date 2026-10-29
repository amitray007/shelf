import type { ContentByteRange, ContentReader, SealedContent } from '@shelf/core';

import { assertSealedContent, resolveContentRange } from './content-id.js';

export const DEFAULT_STORAGE_CACHE_BYTES = 134_217_728;

/** One byte budget for sealed entries, pending stages, and active cache fills. */
export class ContentByteCache {
  readonly objectLimit: number;
  readonly #limit: number;
  readonly #entries = new Map<string, Buffer>();
  #used = 0;

  constructor(limit = DEFAULT_STORAGE_CACHE_BYTES) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('Storage cache bytes must be a non-negative safe integer.');
    }
    this.#limit = limit;
    this.objectLimit = Math.floor(limit / 8);
  }

  key(content: SealedContent): string {
    return `${content.contentId}:${content.contentHash}`;
  }

  get(key: string): Buffer | undefined {
    const bytes = this.#entries.get(key);
    if (bytes !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, bytes);
    }
    return bytes;
  }

  take(key: string): Buffer | undefined {
    const bytes = this.#entries.get(key);
    if (bytes !== undefined) {
      this.#entries.delete(key);
      this.#used -= Math.max(1, bytes.length);
    }
    return bytes;
  }

  deleteContent(contentId: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(`${contentId}:`)) this.take(key);
    }
  }

  clear(): void {
    for (const key of this.#entries.keys()) this.take(key);
  }

  reserve(size: number) {
    if (this.#limit === 0 || size > this.objectLimit) return undefined;
    const charge = Math.max(1, size);
    while (this.#used + charge > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return undefined;
      this.take(oldest);
    }
    this.#used += charge;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.#used -= charge;
    };
    return {
      release,
      commit: (key: string, bytes: Buffer) => {
        if (!active || bytes.length > size) return;
        release();
        this.take(key);
        this.#entries.set(key, bytes);
        this.#used += Math.max(1, bytes.length);
      },
    };
  }

  /** Transfers private staged bytes only after the provider has accepted the seal. */
  seal(stageId: string, content: SealedContent): void {
    const bytes = this.take(`stage:${stageId}`);
    if (bytes === undefined || bytes.length !== content.byteCount) return;
    this.reserve(bytes.length)?.commit(this.key(content), bytes);
  }
}

interface PendingRead {
  controller: AbortController;
  promise: Promise<Buffer>;
  users: number;
}

/** Wraps only byte reads. Callers still authorize each request before invoking this port. */
export class CachedContentReader implements ContentReader {
  readonly #pending = new Map<string, PendingRead>();

  readonly #reader: ContentReader;
  readonly #cache: ContentByteCache;

  constructor(reader: ContentReader, cache: ContentByteCache) {
    this.#reader = reader;
    this.#cache = cache;
  }

  invalidate(contentId: string): void {
    for (const [key, pending] of this.#pending) {
      if (key.startsWith(`${contentId}:`)) {
        pending.controller.abort();
        this.#pending.delete(key);
      }
    }
    this.#cache.deleteContent(contentId);
  }

  close(): void {
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear();
    this.#cache.clear();
  }

  async #load(
    content: SealedContent,
    controller: AbortController,
    reservation: NonNullable<ReturnType<ContentByteCache['reserve']>>,
  ): Promise<Buffer> {
    try {
      const bytes = Buffer.allocUnsafe(content.byteCount);
      let length = 0;
      const source = await this.#reader.read(content, { signal: controller.signal });
      for await (const chunk of source) {
        controller.signal.throwIfAborted();
        if (length + chunk.byteLength > content.byteCount)
          throw new Error('Stored content exceeds its descriptor.');
        bytes.set(chunk, length);
        length += chunk.byteLength;
      }
      controller.signal.throwIfAborted();
      if (length !== content.byteCount) throw new Error('Stored content size mismatch.');
      reservation.commit(this.#cache.key(content), bytes);
      return bytes;
    } finally {
      reservation.release();
    }
  }

  async read(
    content: SealedContent,
    options: { range?: ContentByteRange; signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    options.signal?.throwIfAborted();
    assertSealedContent(content);
    const range =
      content.byteCount === 0 && options.range === undefined
        ? undefined
        : resolveContentRange(options.range, content.byteCount);
    const key = this.#cache.key(content);
    let bytes = this.#cache.get(key);
    if (bytes !== undefined && bytes.length !== content.byteCount) {
      throw new Error('Stored content size mismatch.');
    }
    if (bytes === undefined) {
      let pending = this.#pending.get(key);
      if (pending === undefined) {
        const reservation = this.#cache.reserve(content.byteCount);
        if (reservation === undefined) return this.#reader.read(content, options);
        const controller = new AbortController();
        pending = { controller, users: 0, promise: this.#load(content, controller, reservation) };
        this.#pending.set(key, pending);
        const current = pending;
        void pending.promise
          .finally(() => {
            if (this.#pending.get(key) === current) this.#pending.delete(key);
          })
          .catch(() => undefined);
      }
      const current = pending;
      current.users += 1;
      let released = false;
      const releaseUser = () => {
        if (released) return;
        released = true;
        current.users -= 1;
        if (current.users === 0 && this.#pending.get(key) === current) {
          this.#pending.delete(key);
          current.controller.abort();
        }
      };
      let abort: (() => void) | undefined;
      try {
        bytes = await new Promise<Buffer>((resolve, reject) => {
          abort = () => {
            releaseUser();
            reject(options.signal?.reason);
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
          void current.promise.then(resolve, reject);
        });
        options.signal?.throwIfAborted();
      } finally {
        if (abort !== undefined) options.signal?.removeEventListener('abort', abort);
        releaseUser();
      }
    }
    if (bytes.length !== content.byteCount) throw new Error('Stored content size mismatch.');
    const selected = bytes.subarray(range?.start ?? 0, range === undefined ? 0 : range.end + 1);
    return (async function* () {
      options.signal?.throwIfAborted();
      // Never expose the cache's mutable backing buffer to a consumer.
      if (selected.length > 0) yield Buffer.from(selected);
    })();
  }
}
