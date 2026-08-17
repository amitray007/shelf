import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { ContentReader, ContentStore, SealedContent, StagedContent } from '@shelf/core';

const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^sha256:([a-f0-9]{64})$/u;

function containedPath(root: string, leaf: string): string {
  const candidate = resolve(root, leaf);
  if (!candidate.startsWith(`${resolve(root)}${sep}`)) throw new Error('Unsafe storage path.');
  return candidate;
}

/** Filesystem validation adapter. Supplied file names never participate in a storage path. */
export class TemporaryContentStore implements ContentStore, ContentReader {
  readonly #root: string;
  readonly #stagingRoot: string;
  readonly #sealedRoot: string;
  #preparation: Promise<void> | undefined;

  constructor(root: string) {
    this.#root = resolve(root);
    this.#stagingRoot = join(this.#root, 'staging');
    this.#sealedRoot = join(this.#root, 'sealed');
  }

  #prepare(): Promise<void> {
    this.#preparation ??= Promise.all([
      mkdir(this.#stagingRoot, { mode: 0o700, recursive: true }),
      mkdir(this.#sealedRoot, { mode: 0o700, recursive: true }),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#preparation = undefined;
        throw error;
      });
    return this.#preparation;
  }

  #stagePath(stageId: string): string {
    if (!STAGE_ID_PATTERN.test(stageId) || basename(stageId) !== stageId) {
      throw new Error('Invalid stage identifier.');
    }
    return containedPath(this.#stagingRoot, `${stageId}.stage`);
  }

  #sealedPath(content: SealedContent): string {
    const match = HASH_PATTERN.exec(content.contentHash);
    if (match === null || content.contentId !== content.contentHash) {
      throw new Error('Invalid sealed content identifier.');
    }
    const hash = match[1];
    if (hash === undefined) throw new Error('Invalid sealed content identifier.');
    return containedPath(this.#sealedRoot, hash);
  }

  async stage(
    content: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal },
  ): Promise<StagedContent> {
    await this.#prepare();
    options.signal?.throwIfAborted();
    const stageId = randomUUID();
    const path = this.#stagePath(stageId);
    const handle = await open(path, 'wx', 0o600);
    try {
      await pipeline(Readable.from(content), handle.createWriteStream(), {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { stageId };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async discard(staged: StagedContent): Promise<void> {
    await unlink(this.#stagePath(staged.stageId)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async seal(
    staged: StagedContent,
    descriptor: { contentHash: string; byteCount: number },
  ): Promise<SealedContent> {
    await this.#prepare();
    const match = HASH_PATTERN.exec(descriptor.contentHash);
    if (match === null) throw new Error('Invalid content hash.');
    const hash = match[1];
    if (hash === undefined) throw new Error('Invalid content hash.');
    const stagedPath = this.#stagePath(staged.stageId);
    const sealedPath = containedPath(this.#sealedRoot, hash);
    try {
      await link(stagedPath, sealedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await unlink(stagedPath);
    return { contentId: descriptor.contentHash, ...descriptor };
  }

  async read(
    content: SealedContent,
    options: {
      range?: { start: number; end: number };
      signal?: AbortSignal;
    },
  ): Promise<AsyncIterable<Uint8Array>> {
    options.signal?.throwIfAborted();
    const range = options.range ?? { start: 0, end: content.byteCount - 1 };
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= content.byteCount
    ) {
      throw new Error('Invalid content byte range.');
    }

    const handle = await open(this.#sealedPath(content), 'r');
    try {
      const stats = await handle.stat();
      if (stats.size !== content.byteCount) throw new Error('Sealed content size mismatch.');
      return handle.createReadStream({
        start: range.start,
        end: range.end,
        autoClose: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
}
