import { COMPARISON_LIMITS, type RevisionComparison } from '@shelf/contracts';

import { compareRevisions } from '../client.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

export interface CompareRevisionsCommandOptions {
  url: string;
  base: string;
  target: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
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
