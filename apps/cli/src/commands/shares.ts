import type {
  ProtectedShareExpiryPreset,
  ShareCreateInput,
  ShareCreateResult,
  ShareExpiryPreset,
  ShareManagementSummary,
  SharePage,
  ShareTarget,
} from '@shelf/contracts';
import { SHARE_EXPIRY_PRESETS, SHARE_SESSION_LIMITS } from '@shelf/contracts';

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
  access?: string;
  revision?: string;
  expiresIn?: string;
  expiresAt?: string;
  maxSessions?: string;
  idempotencyKey: string;
}

export interface SharePolicyCommandOptions {
  access?: string;
  expiresIn?: string;
  expiresAt?: string;
  maxSessions?: string;
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

function expiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw usageFailure('The share expiry is invalid.');
  }
  return value;
}

function sessionLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw usageFailure('The maximum session count is invalid.');
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < SHARE_SESSION_LIMITS.minimum ||
    parsed > SHARE_SESSION_LIMITS.maximum
  ) {
    throw usageFailure(
      `The maximum session count must be between ${SHARE_SESSION_LIMITS.minimum} and ${SHARE_SESSION_LIMITS.maximum}.`,
    );
  }
  return parsed;
}

export function shareCreateInput(
  options: SharePolicyCommandOptions,
  shareTarget: ShareTarget,
): ShareCreateInput {
  const accessType = options.access ?? 'protected';
  if (accessType !== 'protected' && accessType !== 'public') {
    throw usageFailure('Share access must be protected or public.');
  }
  if (options.expiresIn !== undefined && options.expiresAt !== undefined) {
    throw usageFailure('--expires-in and --expires-at cannot be combined.');
  }
  const maxSessions = sessionLimit(options.maxSessions);
  if (accessType === 'public' && maxSessions !== undefined) {
    throw usageFailure('--max-sessions is available only for protected shares.');
  }
  let expiresIn: ProtectedShareExpiryPreset | ShareExpiryPreset | undefined;
  if (options.expiresIn !== undefined) {
    const allowed =
      options.expiresIn === 'never' ||
      (SHARE_EXPIRY_PRESETS as readonly string[]).includes(options.expiresIn);
    if (!allowed) {
      throw usageFailure(
        'The expiry preset must be one of: never, 5m, 30m, 2hr, 6hr, 24hr, 3d, 7d, 15d, 30d.',
      );
    }
    if (accessType === 'public' && options.expiresIn === 'never') {
      throw usageFailure('Public shares must expire.');
    }
    expiresIn = options.expiresIn as ProtectedShareExpiryPreset | ShareExpiryPreset;
  }
  const expiresAt = options.expiresAt === undefined ? undefined : expiry(options.expiresAt);
  if (accessType === 'public') {
    return {
      accessType,
      target: shareTarget,
      ...(expiresIn === undefined ? {} : { expiresIn: expiresIn as ShareExpiryPreset }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  return {
    accessType,
    target: shareTarget,
    ...(expiresIn === undefined ? {} : { expiresIn }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(maxSessions === undefined ? {} : { maxSessions }),
  };
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
      input: shareCreateInput(options, target(options.revision)),
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
