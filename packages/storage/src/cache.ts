import type { ContentByteRange, ContentReader, SealedContent } from '@shelf/core';

import { assertSealedContent, resolveContentRange } from './content-id.js';

export const DEFAULT_STORAGE_CACHE_BYTES = 134_217_728;

/** One byte budget for sealed entries, pending stages, and active cache fills. */
export class ContentByteCache {
  readonly objectLimit: number;
  readonly #limit: number;
  readonly #entries = new Map<string, Buffer>();
  #used = 0;
  #reserved = 0;

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

  #makeRoom(charge: number): boolean {
    // Reservations cannot be evicted. Check feasibility before disturbing the LRU.
    if (this.#reserved + charge > this.#limit) return false;
    while (this.#used + charge > this.#limit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return false;
      this.take(oldest);
    }
    return true;
  }

  reserve(size: number) {
    if (!Number.isSafeInteger(size) || size < 0 || this.#limit === 0 || size > this.objectLimit)
      return undefined;
    let charge = Math.max(1, size);
    if (!this.#makeRoom(charge)) return undefined;
    this.#used += charge;
    this.#reserved += charge;
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.#used -= charge;
      this.#reserved -= charge;
    };
    return {
      release,
      grow: (additional: number): boolean => {
        if (
          !active ||
          !Number.isSafeInteger(additional) ||
          additional < 0 ||
          additional > this.objectLimit - size
        )
          return false;
        const nextCharge = Math.max(1, size + additional);
        const increase = nextCharge - charge;
        if (!this.#makeRoom(increase)) return false;
        size += additional;
        charge = nextCharge;
        this.#used += increase;
        this.#reserved += increase;
        return true;
      },
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

/**
 * Objects at least this large stream to the first caller while the cache fills, so a cold read
 * starts sending bytes as soon as storage does. Smaller objects arrive in one or two round trips
 * anyway and keep the all-or-nothing error contract.
 */
export const PROGRESSIVE_FILL_BYTES = 1024 * 1024;
const SLICE_BYTES = 256 * 1024;

interface PendingRead {
  readonly controller: AbortController;
  readonly bytes: Buffer;
  /** Settles when storage opened the object or failed to. */
  readonly opened: Promise<void>;
  /** Settles when every byte arrived and was committed, or the fill failed. */
  promise: Promise<Buffer>;
  filled: number;
  failure: unknown;
  users: number;
  /** A background fill started for a range miss. No caller owns it, so none can cancel it. */
  detached: boolean;
  waiters: Set<() => void>;
}

function settled(pending: PendingRead): boolean {
  return pending.failure !== undefined || pending.filled === pending.bytes.length;
}

function waitForProgress(pending: PendingRead, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.waiters.delete(wake);
      reject(signal?.reason);
    };
    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal?.aborted) return reject(signal.reason);
    pending.waiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function notify(pending: PendingRead): void {
  const waiters = [...pending.waiters];
  pending.waiters.clear();
  for (const wake of waiters) wake();
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

  #start(
    key: string,
    content: SealedContent,
    reservation: NonNullable<ReturnType<ContentByteCache['reserve']>>,
    detached: boolean,
  ): PendingRead {
    const controller = new AbortController();
    let markOpened: (error?: unknown) => void = () => undefined;
    const opened = new Promise<void>((resolve, reject) => {
      markOpened = (error) => (error === undefined ? resolve() : reject(error));
    });
    void opened.catch(() => undefined);
    const pending: PendingRead = {
      controller,
      bytes: Buffer.allocUnsafe(content.byteCount),
      opened,
      promise: Promise.resolve(Buffer.alloc(0)),
      filled: 0,
      failure: undefined,
      users: 0,
      detached,
      waiters: new Set(),
    };
    const load = async (): Promise<Buffer> => {
      try {
        const source = await this.#reader.read(content, { signal: controller.signal });
        markOpened();
        for await (const chunk of source) {
          controller.signal.throwIfAborted();
          if (pending.filled + chunk.byteLength > content.byteCount)
            throw new Error('Stored content exceeds its descriptor.');
          pending.bytes.set(chunk, pending.filled);
          pending.filled += chunk.byteLength;
          notify(pending);
        }
        controller.signal.throwIfAborted();
        if (pending.filled !== content.byteCount) throw new Error('Stored content size mismatch.');
        reservation.commit(key, pending.bytes);
        return pending.bytes;
      } catch (error) {
        pending.failure = error ?? new Error('Stored content read failed.');
        markOpened(pending.failure);
        throw pending.failure;
      } finally {
        reservation.release();
        notify(pending);
      }
    };
    pending.promise = load();
    this.#pending.set(key, pending);
    void pending.promise
      .finally(() => {
        if (this.#pending.get(key) === pending) this.#pending.delete(key);
      })
      .catch(() => undefined);
    return pending;
  }

  #release(key: string, pending: PendingRead): void {
    pending.users -= 1;
    if (
      pending.users === 0 &&
      !pending.detached &&
      !settled(pending) &&
      this.#pending.get(key) === pending
    ) {
      this.#pending.delete(key);
      pending.controller.abort();
    }
  }

  /** Await a fill phase on behalf of one caller, releasing that caller if it gives up first. */
  async #join<T>(
    key: string,
    pending: PendingRead,
    phase: Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        void phase.then(resolve, reject);
      });
    } catch (error) {
      this.#release(key, pending);
      throw error;
    } finally {
      if (abort !== undefined) signal?.removeEventListener('abort', abort);
    }
  }

  /** Streams one range as the fill reaches it. The caller holds the fill until it finishes. */
  #follow(
    key: string,
    pending: PendingRead,
    start: number,
    end: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<Uint8Array> {
    const release = () => this.#release(key, pending);
    return (async function* () {
      let released = false;
      try {
        let offset = start;
        while (offset < end) {
          signal?.throwIfAborted();
          if (pending.filled > offset) {
            const stop = Math.min(pending.filled, end, offset + SLICE_BYTES);
            // Copy: the fill buffer becomes a shared cache entry.
            yield Buffer.from(pending.bytes.subarray(offset, stop));
            offset = stop;
            continue;
          }
          if (pending.failure !== undefined) throw pending.failure;
          if (pending.filled === pending.bytes.length)
            throw new Error('Stored content size mismatch.');
          await waitForProgress(pending, signal);
        }
      } finally {
        if (!released) {
          released = true;
          release();
        }
      }
    })();
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
      const progressive = content.byteCount >= PROGRESSIVE_FILL_BYTES;
      let pending = this.#pending.get(key);
      if (pending !== undefined && pending.bytes.length !== content.byteCount)
        throw new Error('Stored content size mismatch.');
      const start = range?.start ?? 0;
      if (progressive && start > 0 && (pending === undefined || pending.filled <= start)) {
        // A seek into a cold large object (video, PDF) should not wait for the bytes before it.
        // Serve the range directly and warm the cache in the background for later reads.
        if (pending === undefined) {
          const reservation = this.#cache.reserve(content.byteCount);
          if (reservation !== undefined) this.#start(key, content, reservation, true);
        }
        return this.#reader.read(content, options);
      }
      if (pending === undefined) {
        const reservation = this.#cache.reserve(content.byteCount);
        if (reservation === undefined) return this.#reader.read(content, options);
        pending = this.#start(key, content, reservation, false);
      }
      const current = pending;
      current.users += 1;
      if (progressive) {
        await this.#join(key, current, current.opened, options.signal);
        return this.#follow(
          key,
          current,
          start,
          range === undefined ? content.byteCount : range.end + 1,
          options.signal,
        );
      }
      bytes = await this.#join(key, current, current.promise, options.signal);
      this.#release(key, current);
      options.signal?.throwIfAborted();
    }
    if (bytes.length !== content.byteCount) throw new Error('Stored content size mismatch.');
    const selected = bytes.subarray(range?.start ?? 0, range === undefined ? 0 : range.end + 1);
    return (async function* () {
      options.signal?.throwIfAborted();
      // Never expose the cache's mutable backing buffer to a consumer.
      for (let offset = 0; offset < selected.length; offset += SLICE_BYTES) {
        options.signal?.throwIfAborted();
        yield Buffer.from(selected.subarray(offset, offset + SLICE_BYTES));
      }
    })();
  }
}
