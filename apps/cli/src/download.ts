import { randomUUID } from 'node:crypto';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type { RevisionContentDownload } from './client.js';
import { CliFailure, failure, usageFailure } from './output.js';

export interface SafeDownloadResult {
  readonly output: string;
  readonly byteCount: number;
  readonly mediaType: string;
  readonly entityTag: string | null;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function writeChunk(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (written.bytesWritten === 0) throw new Error('The download stopped accepting bytes.');
    offset += written.bytesWritten;
  }
}

/**
 * Streams one authenticated content response into an owner-only temporary file, verifies it
 * against its declared byte count, and publishes it atomically at the requested output path.
 * Without `overwrite` an existing path is never replaced.
 */
export async function downloadToPath(
  request: {
    readonly outputPath: string;
    readonly overwrite?: boolean;
    readonly failureMessage: string;
  },
  start: () => Promise<RevisionContentDownload>,
): Promise<SafeDownloadResult> {
  const output = resolve(request.outputPath);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(output);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw usageFailure('The output path cannot be inspected.');
  }
  if (existing?.isDirectory()) throw usageFailure('The output path identifies a directory.');
  if (existing !== undefined && request.overwrite !== true) {
    throw usageFailure('The output path already exists. Use --overwrite to replace it.');
  }

  const temporaryPath = resolve(dirname(output), `.${basename(output)}.shelf-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
    } catch {
      throw usageFailure('The output directory is not writable.');
    }
    const download = await start();
    body = download.body;
    const reader = body.getReader();
    let byteCount = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        byteCount += item.value.byteLength;
        if (byteCount > download.byteCount) {
          throw new Error('The content exceeded its declared byte count.');
        }
        await writeChunk(handle, item.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (byteCount !== download.byteCount) {
      throw new Error('The content did not match its declared byte count.');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (request.overwrite === true) {
      await rename(temporaryPath, output);
    } else {
      try {
        await link(temporaryPath, output);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          throw usageFailure('The output path already exists. Use --overwrite to replace it.');
        }
        throw error;
      }
    }
    return {
      output,
      byteCount,
      mediaType: download.mediaType,
      entityTag: download.entityTag,
    };
  } catch (error) {
    if (body !== undefined && !body.locked) await body.cancel().catch(() => undefined);
    if (error instanceof CliFailure) throw error;
    throw failure('INTERNAL_ERROR', request.failureMessage);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
