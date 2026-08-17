import type {
  ShareCreateResult,
  ShareManagementSummary,
  SharePage,
  ShareTarget,
} from '@shelf/contracts';

import { createShare, listShares, revokeShare } from '../client.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

interface ShareCommandOptions {
  url: string;
  workspace: string;
  allowInsecureLoopback?: boolean;
}

export interface CreateShareCommandOptions extends ShareCommandOptions {
  artifact: string;
  revision?: string;
  expiresAt?: string;
  idempotencyKey: string;
}

export interface ListSharesCommandOptions extends ShareCommandOptions {
  limit?: string;
  cursor?: string;
}

export interface RevokeShareCommandOptions extends ShareCommandOptions {
  share: string;
}

function token(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

function workspaceId(value: string): string {
  if (value.length === 0 || value.length > 128) throw usageFailure('The workspace ID is invalid.');
  return value;
}

function artifactId(value: string): string {
  if (!/^art_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The artifact ID is invalid.');
  return value;
}

function revisionId(value: string): string {
  if (!/^rev_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The revision ID is invalid.');
  return value;
}

function shareId(value: string): string {
  if (!/^shr_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The share ID is invalid.');
  return value;
}

function idempotencyKey(value: string): string {
  if (value.length === 0 || value.length > 128) {
    throw usageFailure('The idempotency key is invalid.');
  }
  return value;
}

function expiry(value: string | undefined): string | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw usageFailure('The share expiry is invalid.');
  }
  return value;
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/u.test(value)) throw usageFailure('The page limit is invalid.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw usageFailure('The page limit must be between 1 and 100.');
  }
  return parsed;
}

function transport(options: ShareCommandOptions, runtime: CliRuntime) {
  return {
    installationUrl: options.url,
    workspaceId: workspaceId(options.workspace),
    token: token(runtime),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  };
}

function target(revision: string | undefined): ShareTarget {
  return revision === undefined
    ? { mode: 'latest' }
    : { mode: 'pinned', revisionId: revisionId(revision) };
}

export function executeCreateShare(
  options: CreateShareCommandOptions,
  runtime: CliRuntime,
): Promise<ShareCreateResult> {
  return createShare(
    {
      ...transport(options, runtime),
      artifactId: artifactId(options.artifact),
      target: target(options.revision),
      expiresAt: expiry(options.expiresAt),
      idempotencyKey: idempotencyKey(options.idempotencyKey),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeListShares(
  options: ListSharesCommandOptions,
  runtime: CliRuntime,
): Promise<SharePage> {
  return listShares(
    {
      ...transport(options, runtime),
      limit: pageLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeRevokeShare(
  options: RevokeShareCommandOptions,
  runtime: CliRuntime,
): Promise<ShareManagementSummary> {
  return revokeShare(
    {
      ...transport(options, runtime),
      shareId: shareId(options.share),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
