import { createHash, randomBytes } from 'node:crypto';

import {
  PUBLISH_OPERATION,
  READ_REVISION_OPERATION,
  SHARE_CREATE_OPERATION,
  type ShareCreateResult,
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
  CommitShareCreateOutcome,
  RevokeShareOutcome,
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

export function createShareFingerprint(input: {
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

function capabilityUrl(stored: StoredShare, capabilityCodec: ShareCapabilityCodec): string {
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
  return {
    apiVersion: 'v1',
    workspaceId: stored.workspaceId,
    shareId: stored.shareId,
    artifactId: stored.artifactId,
    visibility: 'unlisted',
    target,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
    url: capabilityUrl(stored, capabilityCodec),
  };
}

function createResult(
  stored: StoredShare,
  requestId: string,
  replayed: boolean,
  capabilityCodec: ShareCapabilityCodec,
): ShareCreateResult {
  return {
    apiVersion: 'v1',
    workspaceId: stored.workspaceId,
    shareId: stored.shareId,
    artifactId: stored.artifactId,
    visibility: 'unlisted',
    target:
      stored.target.mode === 'pinned'
        ? { mode: 'pinned', revisionId: stored.target.revisionId }
        : { mode: 'latest' },
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
    requestId,
    url: capabilityUrl(stored, capabilityCodec),
    replayed,
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
}) {
  const clock = dependencies.clock ?? defaultClock;
  const generateShareId = dependencies.generateShareId ?? defaultShareId;
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

  return {
    async createShare(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      artifactId: string;
      target: ShareTarget;
      expiresAt?: string | null;
      idempotencyKey: string;
      requestId: string;
      signal?: AbortSignal;
    }): Promise<ShareCreateResult> {
      validateIdentity(request, { requestId: true, idempotencyKey: true });
      validateTarget(request.target);
      if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new InvalidShareRequestError([
          { field: 'artifactId', reason: 'must be a valid opaque artifact ID' },
        ]);
      }
      const now = clock();
      const expiresAt = request.expiresAt ?? null;
      if (
        expiresAt !== null &&
        (!validInstant(expiresAt) || Date.parse(expiresAt) <= now.getTime())
      ) {
        throw new InvalidShareRequestError([
          { field: 'expiresAt', reason: 'must be a future ISO instant or null' },
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
      request.signal?.throwIfAborted();

      if (request.target.mode === 'pinned') {
        let pinned: StoredShareRevision | undefined;
        try {
          pinned = await dependencies.shares.findRevisionForShare(request.target.revisionId);
        } catch (error) {
          throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision lookup failed.', error);
        }
        if (
          pinned === undefined ||
          pinned.revision.revisionId !== request.target.revisionId ||
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
      const fingerprint = createShareFingerprint({
        artifactId: request.artifactId,
        target: request.target,
        expiresAt,
      });
      let existing: ShareCreateIdempotencyRecord | undefined;
      try {
        existing = await dependencies.shares.findCreateIdempotency(namespace);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share idempotency lookup failed.', error);
      }
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
        return createResult(existing.result, request.requestId, true, dependencies.capabilityCodec);
      }

      const shareId = generateShareId();
      if (!SHARE_ID_PATTERN.test(shareId)) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Share ID generation failed.',
          new Error('The share ID generator returned an invalid ID.'),
        );
      }
      const stored: StoredShare = {
        apiVersion: 'v1',
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        shareId,
        artifactId: request.artifactId,
        visibility: 'unlisted',
        target:
          request.target.mode === 'pinned'
            ? { mode: 'pinned', revisionId: request.target.revisionId }
            : { mode: 'latest' },
        createdByActorId: request.actorId,
        createdAt: now.toISOString(),
        expiresAt,
        revokedAt: null,
        revokedByActorId: null,
      };
      let outcome: CommitShareCreateOutcome;
      try {
        outcome = await dependencies.shares.commitCreate({
          namespace,
          fingerprint,
          result: stored,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Share creation failed.', error);
      }
      if (outcome.status === 'conflict') throw new IdempotencyConflictError();
      return createResult(
        outcome.result,
        request.requestId,
        outcome.status === 'replayed',
        dependencies.capabilityCodec,
      );
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
            summary(item, dependencies.capabilityCodec, await pinnedRevisionNumber(item)),
          ),
        ),
        nextCursor: page.next === undefined ? null : encodeCursor(page.next),
      };
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
        await pinnedRevisionNumber(outcome.result),
      );
    },
  };
}
