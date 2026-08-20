import { COMPARISON_LIMITS, type RevisionComparison } from '@shelf/contracts';

import { compareRevisions, downloadRevisionContent } from '../client.js';
import { resolveRemoteContext, transportFields } from '../context.js';
import { downloadToPath } from '../download.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

export interface CompareRevisionsCommandOptions {
  profile?: string;
  url?: string;
  base: string;
  target: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
}

export interface DownloadRevisionCommandOptions {
  profile?: string;
  url?: string;
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

export async function executeCompareRevisions(
  options: CompareRevisionsCommandOptions,
  runtime: CliRuntime,
): Promise<RevisionComparison> {
  const context = await resolveRemoteContext(options, runtime);
  return compareRevisions(
    {
      ...transportFields(context),
      baseRevisionId: revisionId(options.base),
      targetRevisionId: revisionId(options.target),
      limit: limit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeDownloadRevision(
  options: DownloadRevisionCommandOptions,
  runtime: CliRuntime,
): Promise<RevisionDownloadResult> {
  const id = revisionId(options.revision);
  const context = await resolveRemoteContext(options, runtime);
  const downloaded = await downloadToPath(
    {
      outputPath: options.output,
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
      failureMessage: 'The revision download could not be written safely.',
    },
    () =>
      downloadRevisionContent(
        { ...transportFields(context), revisionId: id },
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      ),
  );
  return {
    apiVersion: 'v1',
    operation: 'revision.download',
    revisionId: id,
    output: downloaded.output,
    byteCount: downloaded.byteCount,
    mediaType: downloaded.mediaType,
    entityTag: downloaded.entityTag,
  };
}
