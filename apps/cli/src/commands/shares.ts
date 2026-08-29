import type {
  ArtifactDefaultShares,
  CommentPolicy,
  RevisionAccess,
  ShareCreateInput,
  ShareCreateResult,
  ShareExpiryPresetWithNever,
  ShareManagementSummary,
  SharePage,
  ShareTarget,
} from '@shelf/contracts';
import { COMMENT_POLICIES, SHARE_EXPIRY_PRESETS, SHARE_SESSION_LIMITS } from '@shelf/contracts';

import {
  createShare,
  ensureArtifactDefaultShares,
  listShares,
  revokeShare,
  setShareCommentPolicy,
} from '../client.js';
import { resolveWorkspaceContext, transportFields } from '../context.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

interface ShareCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  allowInsecureLoopback?: boolean;
}

export interface CreateShareCommandOptions extends ShareCommandOptions {
  artifact: string;
  access?: string;
  comments?: string;
  revisionAccess?: string;
  revision?: string;
  expiresIn?: string;
  expiresAt?: string;
  maxSessions?: string;
  idempotencyKey: string;
}

export interface SharePolicyCommandOptions {
  access?: string;
  comments?: string;
  revisionAccess?: string;
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

export interface ShareCommentsCommandOptions extends ShareCommandOptions {
  share: string;
  comments: string;
}

export interface DefaultSharesCommandOptions extends ShareCommandOptions {
  artifact: string;
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

function commentPolicy(value: string | undefined): CommentPolicy | undefined {
  if (value === undefined) return undefined;
  if (!(COMMENT_POLICIES as readonly string[]).includes(value)) {
    throw usageFailure('Comments must be one of: off, private, shared.');
  }
  return value as CommentPolicy;
}

function revisionAccess(value: string | undefined): RevisionAccess | undefined {
  if (value === undefined) return undefined;
  if (value !== 'target-only' && value !== 'shared-history') {
    throw usageFailure('Revision access must be target-only or shared-history.');
  }
  return value;
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
  const policy = commentPolicy(options.comments);
  const access = revisionAccess(options.revisionAccess);
  if (shareTarget.mode === 'pinned' && access === 'shared-history') {
    throw usageFailure('--revision-access shared-history requires a Latest share.');
  }
  if (accessType === 'public' && maxSessions !== undefined) {
    throw usageFailure('--max-sessions is available only for protected shares.');
  }
  let expiresIn: ShareExpiryPresetWithNever | undefined;
  if (options.expiresIn !== undefined) {
    const allowed =
      options.expiresIn === 'never' ||
      (SHARE_EXPIRY_PRESETS as readonly string[]).includes(options.expiresIn);
    if (!allowed) {
      throw usageFailure(
        'The expiry preset must be one of: never, 5m, 30m, 2hr, 6hr, 24hr, 3d, 7d, 15d, 30d.',
      );
    }
    expiresIn = options.expiresIn as ShareExpiryPresetWithNever;
  }
  const expiresAt = options.expiresAt === undefined ? undefined : expiry(options.expiresAt);
  if (accessType === 'public') {
    return {
      accessType,
      target: shareTarget,
      ...(policy === undefined ? {} : { commentPolicy: policy }),
      ...(access === undefined ? {} : { revisionAccess: access }),
      ...(expiresIn === undefined ? {} : { expiresIn }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
  return {
    accessType,
    target: shareTarget,
    ...(policy === undefined ? {} : { commentPolicy: policy }),
    ...(access === undefined ? {} : { revisionAccess: access }),
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

async function transport(options: ShareCommandOptions, runtime: CliRuntime) {
  const context = await resolveWorkspaceContext(options, runtime);
  return { ...transportFields(context), workspaceId: context.workspaceId };
}

function target(revision: string | undefined): ShareTarget {
  return revision === undefined
    ? { mode: 'latest' }
    : { mode: 'pinned', revisionId: revisionId(revision) };
}

export async function executeCreateShare(
  options: CreateShareCommandOptions,
  runtime: CliRuntime,
): Promise<ShareCreateResult> {
  return createShare(
    {
      ...(await transport(options, runtime)),
      artifactId: artifactId(options.artifact),
      input: shareCreateInput(options, target(options.revision)),
      idempotencyKey: idempotencyKey(options.idempotencyKey),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeListShares(
  options: ListSharesCommandOptions,
  runtime: CliRuntime,
): Promise<SharePage> {
  return listShares(
    {
      ...(await transport(options, runtime)),
      limit: pageLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeDefaultShares(
  options: DefaultSharesCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactDefaultShares> {
  return ensureArtifactDefaultShares(
    {
      ...(await transport(options, runtime)),
      artifactId: artifactId(options.artifact),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeRevokeShare(
  options: RevokeShareCommandOptions,
  runtime: CliRuntime,
): Promise<ShareManagementSummary> {
  return revokeShare(
    {
      ...(await transport(options, runtime)),
      shareId: shareId(options.share),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeSetShareCommentPolicy(
  options: ShareCommentsCommandOptions,
  runtime: CliRuntime,
): Promise<ShareManagementSummary> {
  const policy = commentPolicy(options.comments);
  if (policy === undefined) throw usageFailure('--comments is required.');
  return setShareCommentPolicy(
    {
      ...(await transport(options, runtime)),
      shareId: shareId(options.share),
      commentPolicy: policy,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
