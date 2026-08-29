import { createHash, randomBytes } from 'node:crypto';

import {
  type ArtifactDefaultShares,
  type CommentPolicy,
  PUBLISH_OPERATION,
  READ_REVISION_OPERATION,
  type RevisionAccess,
  SHARE_CREATE_OPERATION,
  SHARE_SESSION_LIMITS,
  type ShareCreateResult,
  type ShareExpiryPresetWithNever,
  type ShareLifecycleStatus,
  type ShareManagementSummary,
  type SharePage,
  type ShareTarget,
} from '@shelf/contracts';
import type { StoredArtifact } from '../artifacts/catalog.js';
import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { Authorizer } from '../publishing/ports.js';
import { ArtifactNotFoundError, IdempotencyConflictError } from '../publishing/publish.js';
import { RevisionNotFoundError } from '../revisions/read.js';
import type {
  ArtifactDefaultShareState,
  CommitShareCreateOutcome,
  PublicShareCodeGenerator,
  RevokeShareOutcome,
  SetShareCommentPolicyOutcome,
  ShareCapabilityCodec,
  ShareClock,
  ShareCreateIdempotencyNamespace,
  ShareCreateIdempotencyRecord,
  ShareIdGenerator,
  ShareRepository,
  StoredShare,
  StoredShareRevision,
} from './ports.js';

const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/u;
const REVISION_ID_PATTERN = /^rev_[A-Za-z0-9_-]{22}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
const PUBLIC_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_PRESET_MS: Record<Exclude<ShareExpiryPresetWithNever, 'never'>, number> = {
  '5m': 5 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '2hr': 2 * 60 * 60 * 1000,
  '6hr': 6 * 60 * 60 * 1000,
  '24hr': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '15d': 15 * 24 * 60 * 60 * 1000,
  '30d': PUBLIC_MAX_LIFETIME_MS,
};

export class InvalidShareRequestError extends ShelfCoreError {
  constructor(details: Array<{ field: string; reason: string }>) {
    super('INVALID_REQUEST', 'The share request is invalid.', {
      retryable: false,
      details,
    });
    this.name = 'InvalidShareRequestError';
  }
}

export class ShareNotFoundError extends ShelfCoreError {
  constructor() {
    super('SHARE_NOT_FOUND', 'The requested share was not found.', { retryable: false });
    this.name = 'ShareNotFoundError';
  }
}

function defaultClock(): Date {
  return new Date();
}

function defaultShareId(): string {
  return `shr_${randomBytes(16).toString('base64url')}`;
}

function defaultPublicCode(): string {
  return randomBytes(9).toString('base64url');
}

function validInstant(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateIdentity(
  request: {
    installationId: string;
    workspaceId: string;
    actorId: string;
    requestId?: string;
    idempotencyKey?: string;
  },
  options: { requestId: boolean; idempotencyKey: boolean },
): void {
  const details: Array<{ field: string; reason: string }> = [];
  const values: Array<[string, string | undefined]> = [
    ['installationId', request.installationId],
    ['workspaceId', request.workspaceId],
    ['actorId', request.actorId],
  ];
  if (options.requestId) values.push(['requestId', request.requestId]);
  if (options.idempotencyKey) values.push(['idempotencyKey', request.idempotencyKey]);
  for (const [field, value] of values) {
    if (value === undefined || value.length === 0 || value.length > 128) {
      details.push({ field, reason: 'must contain 1-128 characters' });
    }
  }
  if (details.length > 0) throw new InvalidShareRequestError(details);
}

function validateTarget(target: ShareTarget): void {
  if (target.mode === 'latest') return;
  if (target.mode !== 'pinned' || !REVISION_ID_PATTERN.test(target.revisionId)) {
    throw new InvalidShareRequestError([
      { field: 'target', reason: 'must select latest or one valid opaque revision ID' },
    ]);
  }
}

function revisionAccess(stored: StoredShare): RevisionAccess {
  return stored.revisionAccess ?? 'target-only';
}

export function createShareFingerprint(input: {
  artifactId: string;
  target: ShareTarget;
  expiresAt: string | null;
  commentPolicy?: CommentPolicy;
}): string {
  const canonical = JSON.stringify({
    version: 1,
    artifactId: input.artifactId,
    target: input.target,
    expiresAt: input.expiresAt,
    commentPolicy: input.commentPolicy ?? 'off',
  });
  return `share-create-request/v1:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function createLegacyShareFingerprint(input: {
  artifactId: string;
  target: ShareTarget;
  expiresAt: string | null;
}): string {
  const canonical = JSON.stringify({
    version: 1,
    artifactId: input.artifactId,
    target: input.target,
    expiresAt: input.expiresAt,
  });
  return `share-create-request/v1:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function createSharePolicyFingerprint(input: {
  artifactId: string;
  target: ShareTarget;
  accessType: 'protected' | 'public';
  expiry: { expiresIn: ShareExpiryPresetWithNever } | { expiresAt: string | null };
  maxSessions: number | null;
  commentPolicy?: CommentPolicy;
  revisionAccess?: RevisionAccess;
  purpose?: 'artifact-default' | 'artifact-recovery';
}): string {
  const canonical = JSON.stringify({
    version: 3,
    commentPolicy: input.commentPolicy ?? 'off',
    artifactId: input.artifactId,
    target: input.target,
    accessType: input.accessType,
    expiry: input.expiry,
    maxSessions: input.maxSessions,
    ...(input.revisionAccess === undefined || input.revisionAccess === 'target-only'
      ? {}
      : { revisionAccess: input.revisionAccess }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  });
  return `share-create-request/v2:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function shareLifecycleStatus(stored: StoredShare, now: Date): ShareLifecycleStatus {
  if (stored.revokedAt !== null) return 'revoked';
  if (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= now.getTime()) return 'expired';
  if (
    stored.accessType === 'protected' &&
    stored.maxSessions !== null &&
    stored.sessionsUsed >= stored.maxSessions
  ) {
    return 'session-limit-reached';
  }
  return 'active';
}

function capabilityUrl(stored: StoredShare, capabilityCodec: ShareCapabilityCodec): string {
  if (stored.accessType === 'public') {
    if (stored.publicCode === null || !PUBLIC_CODE_PATTERN.test(stored.publicCode)) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Public share URL generation failed.',
        new Error('The stored Public selector is invalid.'),
      );
    }
    return `/s/${stored.publicCode}`;
  }
  let secret: string;
  try {
    secret = capabilityCodec.deriveSecret(stored.shareId);
  } catch (error) {
    throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share capability generation failed.', error);
  }
  if (!CAPABILITY_PATTERN.test(secret)) {
    throw boundaryFailure(
      'SERVICE_UNAVAILABLE',
      'Share capability generation failed.',
      new Error('The share capability codec returned an invalid secret.'),
    );
  }
  return `/s/${stored.shareId}#${secret}`;
}

function summary(
  stored: StoredShare,
  capabilityCodec: ShareCapabilityCodec,
  now: Date,
  pinnedRevisionNumber?: number,
): ShareManagementSummary {
  if (stored.target.mode === 'pinned' && pinnedRevisionNumber === undefined) {
    throw boundaryFailure(
      'SERVICE_UNAVAILABLE',
      'Pinned share revision lookup failed.',
      new Error('The pinned share revision number is unavailable.'),
    );
  }
  const target =
    stored.target.mode === 'pinned' && pinnedRevisionNumber !== undefined
      ? {
          mode: 'pinned' as const,
          revisionId: stored.target.revisionId,
          revisionNumber: pinnedRevisionNumber,
        }
      : { mode: 'latest' as const };
  const common = {
    apiVersion: 'v1' as const,
    workspaceId: stored.workspaceId,
    shareId: stored.shareId,
    artifactId: stored.artifactId,
    visibility: 'unlisted' as const,
    target,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
    status: shareLifecycleStatus(stored, now),
    commentPolicy: stored.commentPolicy ?? 'off',
    revisionAccess: revisionAccess(stored),
    url: capabilityUrl(stored, capabilityCodec),
  };
  if (stored.accessType === 'public') {
    if (stored.publicCode === null) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Share listing returned invalid policy state.',
        new Error('A Public share is missing its selector.'),
      );
    }
    return {
      ...common,
      accessType: 'public',
      publicCode: stored.publicCode,
      expiresAt: stored.expiresAt,
    };
  }
  if (stored.maxSessions === null) {
    return {
      ...common,
      accessType: 'protected',
      maxSessions: null,
      sessionsUsed: stored.sessionsUsed,
      sessionsRemaining: null,
    };
  }
  return {
    ...common,
    accessType: 'protected',
    maxSessions: stored.maxSessions,
    sessionsUsed: stored.sessionsUsed,
    sessionsRemaining: Math.max(0, stored.maxSessions - stored.sessionsUsed),
  };
}

function defaultSummary(
  stored: StoredShare,
  expectedAccessType: 'protected',
  capabilityCodec: ShareCapabilityCodec,
  now: Date,
): ArtifactDefaultShares['protected'];
function defaultSummary(
  stored: StoredShare,
  expectedAccessType: 'public',
  capabilityCodec: ShareCapabilityCodec,
  now: Date,
): ArtifactDefaultShares['public'];
function defaultSummary(
  stored: StoredShare,
  expectedAccessType: 'protected' | 'public',
  capabilityCodec: ShareCapabilityCodec,
  now: Date,
): ArtifactDefaultShares['protected'] | ArtifactDefaultShares['public'] {
  const projected = summary(stored, capabilityCodec, now);
  if (projected.accessType !== expectedAccessType) {
    throw boundaryFailure(
      'SERVICE_UNAVAILABLE',
      'Default share lookup returned invalid policy state.',
      new Error(`Expected ${expectedAccessType} default, received ${projected.accessType}.`),
    );
  }
  return projected;
}

function createResult(
  stored: StoredShare,
  requestId: string,
  replayed: boolean,
  capabilityCodec: ShareCapabilityCodec,
  now: Date,
): ShareCreateResult {
  const common = {
    apiVersion: 'v1' as const,
    workspaceId: stored.workspaceId,
    shareId: stored.shareId,
    artifactId: stored.artifactId,
    visibility: 'unlisted' as const,
    target:
      stored.target.mode === 'pinned'
        ? { mode: 'pinned' as const, revisionId: stored.target.revisionId }
        : { mode: 'latest' as const },
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
    status: shareLifecycleStatus(stored, now),
    commentPolicy: stored.commentPolicy ?? 'off',
    revisionAccess: revisionAccess(stored),
    requestId,
    url: capabilityUrl(stored, capabilityCodec),
    replayed,
  };
  if (stored.accessType === 'public') {
    if (stored.publicCode === null) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Share creation returned invalid policy state.',
        new Error('A Public share is missing its selector.'),
      );
    }
    return {
      ...common,
      accessType: 'public',
      publicCode: stored.publicCode,
      expiresAt: stored.expiresAt,
    };
  }
  if (stored.maxSessions === null) {
    return {
      ...common,
      accessType: 'protected',
      maxSessions: null,
      sessionsUsed: stored.sessionsUsed,
      sessionsRemaining: null,
    };
  }
  return {
    ...common,
    accessType: 'protected',
    maxSessions: stored.maxSessions,
    sessionsUsed: stored.sessionsUsed,
    sessionsRemaining: Math.max(0, stored.maxSessions - stored.sessionsUsed),
  };
}

function decodeCursor(
  value: string | undefined,
): { createdAt: string; shareId: string } | undefined {
  if (value === undefined) return undefined;
  try {
    if (!CURSOR_PATTERN.test(value)) throw new Error('invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).v !== 1 ||
      typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
      !validInstant((parsed as { createdAt: string }).createdAt) ||
      typeof (parsed as Record<string, unknown>).shareId !== 'string' ||
      !SHARE_ID_PATTERN.test((parsed as { shareId: string }).shareId)
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as { createdAt: string; shareId: string };
  } catch {
    throw new InvalidShareRequestError([{ field: 'cursor', reason: 'must be a valid cursor' }]);
  }
}

function encodeCursor(value: { createdAt: string; shareId: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
}

export function createShareLifecycleService(dependencies: {
  authorizer: Authorizer;
  shares: ShareRepository;
  capabilityCodec: ShareCapabilityCodec;
  clock?: ShareClock;
  generateShareId?: ShareIdGenerator;
  generatePublicCode?: PublicShareCodeGenerator;
}) {
  const clock = dependencies.clock ?? defaultClock;
  const generateShareId = dependencies.generateShareId ?? defaultShareId;
  const generatePublicCode = dependencies.generatePublicCode ?? defaultPublicCode;
  const pinnedRevisionNumber = async (stored: StoredShare): Promise<number | undefined> => {
    if (stored.target.mode !== 'pinned') return undefined;
    let pinned: StoredShareRevision | undefined;
    try {
      pinned = await dependencies.shares.findRevisionForShare(stored.target.revisionId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Pinned share revision lookup failed.', error);
    }
    if (
      pinned === undefined ||
      pinned.installationId !== stored.installationId ||
      pinned.workspaceId !== stored.workspaceId ||
      pinned.artifactId !== stored.artifactId ||
      pinned.revision.revisionId !== stored.target.revisionId
    ) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Pinned share revision lookup failed.',
        new Error('The pinned share revision is unavailable or crossed its stored scope.'),
      );
    }
    return pinned.revision.revisionNumber;
  };

  const createShare = async (request: {
    installationId: string;
    workspaceId: string;
    actorId: string;
    artifactId: string;
    target?: ShareTarget;
    accessType?: 'protected' | 'public';
    expiresIn?: ShareExpiryPresetWithNever;
    expiresAt?: string | null;
    maxSessions?: number;
    idempotencyKey: string;
    requestId: string;
    signal?: AbortSignal;
    purpose?: 'artifact-default' | 'artifact-recovery';
    commentPolicy?: CommentPolicy;
    revisionAccess?: RevisionAccess;
  }): Promise<ShareCreateResult> => {
    validateIdentity(request, { requestId: true, idempotencyKey: true });
    const target = request.target ?? { mode: 'latest' as const };
    const accessType = request.accessType ?? 'protected';
    const requestedRevisionAccess = request.revisionAccess ?? 'target-only';
    validateTarget(target);
    if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
      throw new InvalidShareRequestError([
        { field: 'artifactId', reason: 'must be a valid opaque artifact ID' },
      ]);
    }
    const details: Array<{ field: string; reason: string }> = [];
    if (request.expiresIn !== undefined && request.expiresAt !== undefined) {
      details.push({ field: 'expiresAt', reason: 'cannot be combined with expiresIn' });
    }
    if (
      request.maxSessions !== undefined &&
      (!Number.isInteger(request.maxSessions) ||
        request.maxSessions < SHARE_SESSION_LIMITS.minimum ||
        request.maxSessions > SHARE_SESSION_LIMITS.maximum)
    ) {
      details.push({ field: 'maxSessions', reason: 'must be an integer from 1 through 1000000' });
    }
    if (accessType === 'public' && request.maxSessions !== undefined) {
      details.push({ field: 'maxSessions', reason: 'is not supported for Public shares' });
    }
    if (requestedRevisionAccess === 'shared-history' && target.mode !== 'latest') {
      details.push({
        field: 'revisionAccess',
        reason: 'shared history is available only for Latest shares',
      });
    }
    if (details.length > 0) throw new InvalidShareRequestError(details);

    const semanticExpiry =
      request.expiresIn !== undefined
        ? ({ expiresIn: request.expiresIn } as const)
        : ({ expiresAt: request.expiresAt ?? null } as const);
    const legacyEquivalent =
      accessType === 'protected' &&
      request.purpose === undefined &&
      request.expiresIn === undefined &&
      request.maxSessions === undefined &&
      requestedRevisionAccess === 'target-only';
    const fingerprint = legacyEquivalent
      ? createShareFingerprint({
          artifactId: request.artifactId,
          target,
          expiresAt: request.expiresAt ?? null,
          ...(request.commentPolicy === undefined ? {} : { commentPolicy: request.commentPolicy }),
        })
      : createSharePolicyFingerprint({
          artifactId: request.artifactId,
          target,
          accessType,
          expiry: semanticExpiry,
          maxSessions: request.maxSessions ?? null,
          ...(request.commentPolicy === undefined ? {} : { commentPolicy: request.commentPolicy }),
          ...(requestedRevisionAccess === 'target-only'
            ? {}
            : { revisionAccess: requestedRevisionAccess }),
          ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
        });
    const legacyFingerprint =
      legacyEquivalent && request.commentPolicy === undefined
        ? createLegacyShareFingerprint({
            artifactId: request.artifactId,
            target,
            expiresAt: request.expiresAt ?? null,
          })
        : undefined;

    let artifact: StoredArtifact | undefined;
    try {
      request.signal?.throwIfAborted();
      artifact = await dependencies.shares.findArtifactForShare(request.artifactId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
    }
    if (
      artifact === undefined ||
      artifact.artifactId !== request.artifactId ||
      artifact.installationId !== request.installationId ||
      artifact.workspaceId !== request.workspaceId
    ) {
      throw new ArtifactNotFoundError();
    }

    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        action: PUBLISH_OPERATION,
      },
      request.signal,
    );
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    request.signal?.throwIfAborted();

    if (target.mode === 'pinned') {
      let pinned: StoredShareRevision | undefined;
      try {
        pinned = await dependencies.shares.findRevisionForShare(target.revisionId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision lookup failed.', error);
      }
      if (
        pinned === undefined ||
        pinned.revision.revisionId !== target.revisionId ||
        pinned.installationId !== request.installationId ||
        pinned.workspaceId !== request.workspaceId ||
        pinned.artifactId !== request.artifactId ||
        (pinned.revision.kind ?? 'file') !== (artifact.kind ?? 'file')
      ) {
        throw new RevisionNotFoundError();
      }
    }

    const namespace: ShareCreateIdempotencyNamespace = {
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      actorId: request.actorId,
      operation: SHARE_CREATE_OPERATION,
      key: request.idempotencyKey,
    };
    let existing: ShareCreateIdempotencyRecord | undefined;
    try {
      existing = await dependencies.shares.findCreateIdempotency(namespace);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share idempotency lookup failed.', error);
    }
    if (existing !== undefined) {
      const compatibleLegacyReplay =
        legacyFingerprint !== undefined && existing.fingerprint === legacyFingerprint;
      if (!compatibleLegacyReplay && existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      if (compatibleLegacyReplay && dependencies.shares.rewriteCreateIdempotencyFingerprint) {
        try {
          await dependencies.shares.rewriteCreateIdempotencyFingerprint({
            namespace,
            fingerprint,
          });
        } catch (error) {
          throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share idempotency upgrade failed.', error);
        }
      }
      return createResult(
        existing.result,
        request.requestId,
        true,
        dependencies.capabilityCodec,
        clock(),
      );
    }

    const now = clock();
    let expiresAt: string | null;
    if ('expiresIn' in semanticExpiry) {
      expiresAt =
        semanticExpiry.expiresIn === 'never'
          ? null
          : new Date(now.getTime() + SESSION_PRESET_MS[semanticExpiry.expiresIn]).toISOString();
    } else {
      expiresAt = semanticExpiry.expiresAt;
    }
    if (
      expiresAt !== null &&
      (!validInstant(expiresAt) || Date.parse(expiresAt) <= now.getTime())
    ) {
      throw new InvalidShareRequestError([
        { field: 'expiresAt', reason: 'must be a future ISO instant or null' },
      ]);
    }
    if (
      accessType === 'public' &&
      expiresAt !== null &&
      Date.parse(expiresAt) - now.getTime() > PUBLIC_MAX_LIFETIME_MS
    ) {
      throw new InvalidShareRequestError([
        { field: 'expiresAt', reason: 'finite Public shares cannot exceed 30 days' },
      ]);
    }

    const shareId = generateShareId();
    if (!SHARE_ID_PATTERN.test(shareId)) {
      throw boundaryFailure(
        'SERVICE_UNAVAILABLE',
        'Share ID generation failed.',
        new Error('The share ID generator returned an invalid ID.'),
      );
    }
    const baseStored: Omit<StoredShare, 'publicCode'> = {
      apiVersion: 'v1',
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      shareId,
      artifactId: request.artifactId,
      visibility: 'unlisted',
      accessType,
      target:
        target.mode === 'pinned'
          ? { mode: 'pinned', revisionId: target.revisionId }
          : { mode: 'latest' },
      createdByActorId: request.actorId,
      createdAt: now.toISOString(),
      expiresAt,
      maxSessions: accessType === 'protected' ? (request.maxSessions ?? null) : null,
      sessionsUsed: 0,
      revokedAt: null,
      revokedByActorId: null,
      commentPolicy: request.commentPolicy ?? 'off',
      revisionAccess: requestedRevisionAccess,
      historyFromRevisionNumber:
        requestedRevisionAccess === 'shared-history'
          ? artifact.latestRevision.revisionNumber
          : null,
    };
    const attempts = accessType === 'public' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const publicCode = accessType === 'public' ? generatePublicCode() : null;
      if (publicCode !== null && !PUBLIC_CODE_PATTERN.test(publicCode)) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Public share selector generation failed.',
          new Error('The Public selector generator returned an invalid selector.'),
        );
      }
      const stored: StoredShare = { ...baseStored, publicCode };
      let outcome: CommitShareCreateOutcome;
      try {
        outcome = await dependencies.shares.commitCreate({
          namespace,
          fingerprint,
          result: stored,
          purpose: request.purpose ?? 'user-created',
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share creation failed.', error);
      }
      if (outcome.status === 'conflict') throw new IdempotencyConflictError();
      if (outcome.status === 'public-code-conflict') continue;
      if (outcome.status === 'default-conflict') {
        let defaults: ArtifactDefaultShareState;
        try {
          defaults = await dependencies.shares.findArtifactDefaultShares({
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            artifactId: request.artifactId,
          });
        } catch (error) {
          throw boundaryFailure('SERVICE_UNAVAILABLE', 'Default share lookup failed.', error);
        }
        const winner = defaults[accessType];
        if (request.purpose === 'artifact-default' && winner !== undefined) {
          return createResult(winner, request.requestId, true, dependencies.capabilityCodec, now);
        }
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Default share provisioning failed.',
          new Error('The active default uniqueness winner is unavailable.'),
        );
      }
      return createResult(
        outcome.result,
        request.requestId,
        outcome.status === 'replayed',
        dependencies.capabilityCodec,
        now,
      );
    }
    throw boundaryFailure(
      'SERVICE_UNAVAILABLE',
      'Public share selector generation failed.',
      new Error('Public selector uniqueness retries were exhausted.'),
    );
  };

  return {
    createShare,

    async ensureDefaultShares(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      artifactId: string;
      requestId: string;
      signal?: AbortSignal;
    }): Promise<ArtifactDefaultShares> {
      validateIdentity(request, { requestId: true, idempotencyKey: false });
      if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new InvalidShareRequestError([
          { field: 'artifactId', reason: 'must be a valid opaque artifact ID' },
        ]);
      }
      let artifact: StoredArtifact | undefined;
      try {
        request.signal?.throwIfAborted();
        artifact = await dependencies.shares.findArtifactForShare(request.artifactId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
      }
      if (
        artifact === undefined ||
        artifact.artifactId !== request.artifactId ||
        artifact.installationId !== request.installationId ||
        artifact.workspaceId !== request.workspaceId
      ) {
        throw new ArtifactNotFoundError();
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: PUBLISH_OPERATION,
        },
        request.signal,
      );
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      let state: ArtifactDefaultShareState;
      try {
        state = await dependencies.shares.findArtifactDefaultShares(request);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Default share lookup failed.', error);
      }
      for (const accessType of ['protected', 'public'] as const) {
        if (state[accessType] !== undefined) continue;
        await createShare({
          ...request,
          accessType,
          target: { mode: 'latest' },
          expiresIn: 'never',
          purpose: 'artifact-default',
          idempotencyKey: `default-${accessType}-${request.artifactId}-v${state.generations[accessType] + 1}`,
        });
      }
      try {
        state = await dependencies.shares.findArtifactDefaultShares(request);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Default share lookup failed.', error);
      }
      if (state.protected === undefined || state.public === undefined) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Default share provisioning failed.',
          new Error('The repository did not return both active default shares.'),
        );
      }
      const now = clock();
      return {
        apiVersion: 'v1',
        workspaceId: request.workspaceId,
        artifactId: request.artifactId,
        protected: defaultSummary(state.protected, 'protected', dependencies.capabilityCodec, now),
        public: defaultSummary(state.public, 'public', dependencies.capabilityCodec, now),
      };
    },

    async listShares(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      limit: number;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<SharePage> {
      validateIdentity(request, { requestId: false, idempotencyKey: false });
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new InvalidShareRequestError([{ field: 'limit', reason: 'must be a valid limit' }]);
      }
      const after = decodeCursor(request.cursor);
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      let page: {
        items: StoredShare[];
        next?: { createdAt: string; shareId: string };
      };
      try {
        page = await dependencies.shares.listShares({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          limit: request.limit,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share listing failed.', error);
      }
      if (
        page.items.some(
          (item) =>
            item.installationId !== request.installationId ||
            item.workspaceId !== request.workspaceId,
        )
      ) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Share listing returned invalid scope.',
          new Error('Share repository crossed its requested scope.'),
        );
      }
      return {
        apiVersion: 'v1',
        workspaceId: request.workspaceId,
        items: await Promise.all(
          page.items.map(async (item) =>
            summary(item, dependencies.capabilityCodec, clock(), await pinnedRevisionNumber(item)),
          ),
        ),
        nextCursor: page.next === undefined ? null : encodeCursor(page.next),
      };
    },

    async resolveManagedShare(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      shareId?: string;
      publicCode?: string;
      signal?: AbortSignal;
    }): Promise<ShareManagementSummary> {
      validateIdentity(request, { requestId: false, idempotencyKey: false });
      const hasShareId = request.shareId !== undefined;
      const hasPublicCode = request.publicCode !== undefined;
      if (
        hasShareId === hasPublicCode ||
        (request.shareId !== undefined && !SHARE_ID_PATTERN.test(request.shareId)) ||
        (request.publicCode !== undefined && !PUBLIC_CODE_PATTERN.test(request.publicCode))
      ) {
        throw new ShareNotFoundError();
      }
      let stored: StoredShare | undefined;
      try {
        stored =
          request.shareId === undefined
            ? await dependencies.shares.findShareByPublicCode(request.publicCode as string)
            : await dependencies.shares.findShare(request.shareId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share lookup failed.', error);
      }
      if (
        stored === undefined ||
        stored.installationId !== request.installationId ||
        stored.workspaceId !== request.workspaceId
      ) {
        throw new ShareNotFoundError();
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      return summary(
        stored,
        dependencies.capabilityCodec,
        clock(),
        await pinnedRevisionNumber(stored),
      );
    },

    async revokeShare(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      shareId: string;
      signal?: AbortSignal;
    }): Promise<ShareManagementSummary> {
      validateIdentity(request, { requestId: false, idempotencyKey: false });
      if (!SHARE_ID_PATTERN.test(request.shareId)) throw new ShareNotFoundError();
      let stored: StoredShare | undefined;
      try {
        request.signal?.throwIfAborted();
        stored = await dependencies.shares.findShare(request.shareId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share lookup failed.', error);
      }
      if (
        stored === undefined ||
        stored.shareId !== request.shareId ||
        stored.installationId !== request.installationId ||
        stored.workspaceId !== request.workspaceId
      ) {
        throw new ShareNotFoundError();
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: PUBLISH_OPERATION,
        },
        request.signal,
      );
      request.signal?.throwIfAborted();
      let outcome: RevokeShareOutcome;
      try {
        outcome = await dependencies.shares.revokeShare({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          shareId: request.shareId,
          revokedByActorId: request.actorId,
          revokedAt: clock().toISOString(),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share revocation failed.', error);
      }
      if (outcome.status === 'not-found') throw new ShareNotFoundError();
      return summary(
        outcome.result,
        dependencies.capabilityCodec,
        clock(),
        await pinnedRevisionNumber(outcome.result),
      );
    },

    async setCommentPolicy(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      shareId: string;
      commentPolicy: CommentPolicy;
      signal?: AbortSignal;
    }): Promise<ShareManagementSummary> {
      validateIdentity(request, { requestId: false, idempotencyKey: false });
      if (!SHARE_ID_PATTERN.test(request.shareId)) throw new ShareNotFoundError();
      let stored: StoredShare | undefined;
      try {
        stored = await dependencies.shares.findShare(request.shareId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share lookup failed.', error);
      }
      if (
        stored === undefined ||
        stored.installationId !== request.installationId ||
        stored.workspaceId !== request.workspaceId
      )
        throw new ShareNotFoundError();
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: PUBLISH_OPERATION,
        },
        request.signal,
      );
      let outcome: SetShareCommentPolicyOutcome;
      try {
        outcome = await dependencies.shares.setCommentPolicy({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          shareId: request.shareId,
          commentPolicy: request.commentPolicy,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share comment policy update failed.', error);
      }
      if (outcome.status === 'not-found') throw new ShareNotFoundError();
      return summary(
        outcome.result,
        dependencies.capabilityCodec,
        clock(),
        await pinnedRevisionNumber(outcome.result),
      );
    },
  };
}
