import { constants } from 'node:fs';
import { access, link, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type { ContentByteRange, SealedContent, StagedContent } from '@shelf/core';

import {
  assertContentId,
  assertDescriptor,
  assertSealedContent,
  assertStagedContent,
  createContentId,
  resolveContentRange,
} from './content-id.js';
import type { ContentStorage } from './types.js';

export interface LocalContentStorageOptions {
  root: string;
}

function childPath(root: string, leaf: string): string {
  const candidate = resolve(root, leaf);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error('Unsafe storage path.');
  return candidate;
}

/**
 * Single-host production content storage. The configured root must be on one durable local
 * filesystem and must not be shared by independent Shelf installations.
 */
export class LocalContentStorage implements ContentStorage {
  readonly #stagingRoot: string;
  readonly #objectsRoot: string;
  #preparation: Promise<void> | undefined;
  #writableInitialization: Promise<void> | undefined;

  constructor(options: LocalContentStorageOptions) {
    const root = resolve(options.root);
    this.#stagingRoot = resolve(root, 'staging');
    this.#objectsRoot = resolve(root, 'objects');
  }

  close(): void {}

  async ready(): Promise<void> {
    this.#writableInitialization ??= this.#verifyWritable().catch((error: unknown) => {
      this.#writableInitialization = undefined;
      throw error;
    });
    await this.#writableInitialization;
    await Promise.all([
      access(this.#stagingRoot, constants.W_OK),
      access(this.#objectsRoot, constants.R_OK | constants.W_OK),
    ]);
  }

  async #verifyWritable(): Promise<void> {
    await this.#prepare();
    const probe = this.#stagePath(createContentId());
    const handle = await open(probe, 'wx', 0o600);
    try {
      await handle.writeFile('shelf-ready');
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(probe).catch(() => undefined);
    }
  }

  #prepare(): Promise<void> {
    this.#preparation ??= Promise.all([
      mkdir(this.#stagingRoot, { mode: 0o700, recursive: true }),
      mkdir(this.#objectsRoot, { mode: 0o700, recursive: true }),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#preparation = undefined;
        throw error;
      });
    return this.#preparation;
  }

  #stagePath(contentId: string): string {
    assertContentId(contentId);
    return childPath(this.#stagingRoot, `${contentId}.stage`);
  }

  #objectPath(contentId: string): string {
    assertContentId(contentId);
    return childPath(this.#objectsRoot, contentId);
  }

  async stage(
    content: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal },
  ): Promise<StagedContent> {
    await this.#prepare();
    options.signal?.throwIfAborted();
    const stageId = createContentId();
    const path = this.#stagePath(stageId);
    const handle = await open(path, 'wx', 0o600);
    try {
      let position = 0;
      for await (const chunk of content) {
        options.signal?.throwIfAborted();
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            position,
          );
          if (bytesWritten === 0) throw new Error('Content staging made no write progress.');
          offset += bytesWritten;
          position += bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      return { stageId };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async discard(staged: StagedContent): Promise<void> {
    assertStagedContent(staged);
    await unlink(this.#stagePath(staged.stageId)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async seal(
    staged: StagedContent,
    descriptor: { contentHash: string; byteCount: number },
  ): Promise<SealedContent> {
    await this.#prepare();
    assertStagedContent(staged);
    assertDescriptor(descriptor);
    const stagedPath = this.#stagePath(staged.stageId);
    const handle = await open(stagedPath, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== descriptor.byteCount) {
        throw new Error('Staged content size mismatch.');
      }
    } finally {
      await handle.close();
    }

    await link(stagedPath, this.#objectPath(staged.stageId));
    await unlink(stagedPath);
    return Object.freeze({ contentId: staged.stageId, ...descriptor });
  }

  async read(
    content: SealedContent,
    options: { range?: ContentByteRange; signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    options.signal?.throwIfAborted();
    assertSealedContent(content);
    const range = resolveContentRange(options.range, content.byteCount);
    const handle = await open(this.#objectPath(content.contentId), 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size !== content.byteCount) {
        throw new Error('Sealed content size mismatch.');
      }
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
