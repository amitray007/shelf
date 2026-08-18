import { randomUUID } from 'node:crypto';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { COMPARISON_LIMITS, type RevisionComparison } from '@shelf/contracts';

import { compareRevisions, downloadRevisionContent } from '../client.js';
import { CliFailure, failure, usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

export interface CompareRevisionsCommandOptions {
  url: string;
  base: string;
  target: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
}

export interface DownloadRevisionCommandOptions {
  url: string;
  revision: string;
  output: string;
  overwrite?: boolean;
  allowInsecureLoopback?: boolean;
}

export interface RevisionDownloadResult {
  apiVersion: 'v1';
  operation: 'revision.download';
  revisionId: string;
  output: string;
  byteCount: number;
  mediaType: string;
  entityTag: string | null;
}

function revisionId(value: string): string {
  if (!/^rev_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The revision ID is invalid.');
  return value;
}

function limit(value: string | undefined): number {
  if (value === undefined) return COMPARISON_LIMITS.pageSize;
  if (!/^\d+$/u.test(value)) throw usageFailure('The comparison limit is invalid.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > COMPARISON_LIMITS.pageSize) {
    throw usageFailure(`The comparison limit must be between 1 and ${COMPARISON_LIMITS.pageSize}.`);
  }
  return parsed;
}

function token(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

export function executeCompareRevisions(
  options: CompareRevisionsCommandOptions,
  runtime: CliRuntime,
): Promise<RevisionComparison> {
  return compareRevisions(
    {
      installationUrl: options.url,
      baseRevisionId: revisionId(options.base),
      targetRevisionId: revisionId(options.target),
      limit: limit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
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
    if (written.bytesWritten === 0) throw new Error('Revision output stopped accepting bytes.');
    offset += written.bytesWritten;
  }
}

export async function executeDownloadRevision(
  options: DownloadRevisionCommandOptions,
  runtime: CliRuntime,
): Promise<RevisionDownloadResult> {
  const id = revisionId(options.revision);
  const output = resolve(options.output);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(output);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw usageFailure('The output path cannot be inspected.');
  }
  if (existing?.isDirectory()) throw usageFailure('The output path identifies a directory.');
  if (existing !== undefined && options.overwrite !== true) {
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
    const download = await downloadRevisionContent(
      {
        installationUrl: options.url,
        revisionId: id,
        token: token(runtime),
        ...(options.allowInsecureLoopback === undefined
          ? {}
          : { allowInsecureLoopback: options.allowInsecureLoopback }),
      },
      runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
    );
    body = download.body;
    const reader = body.getReader();
    let byteCount = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        byteCount += item.value.byteLength;
        if (byteCount > download.byteCount) {
          throw new Error('Revision content exceeded its declared byte count.');
        }
        await writeChunk(handle, item.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (byteCount !== download.byteCount) {
      throw new Error('Revision content did not match its declared byte count.');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (options.overwrite === true) {
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
      apiVersion: 'v1',
      operation: 'revision.download',
      revisionId: id,
      output,
      byteCount,
      mediaType: download.mediaType,
      entityTag: download.entityTag,
    };
  } catch (error) {
    if (body !== undefined && !body.locked) await body.cancel().catch(() => undefined);
    if (error instanceof CliFailure) throw error;
    throw failure('INTERNAL_ERROR', 'The revision download could not be written safely.');
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
