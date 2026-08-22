import { createHash } from 'node:crypto';

import {
  type Artifact,
  type ArtifactDeletionResult,
  PUBLISH_OPERATION,
  READ_REVISION_OPERATION,
  RECOVER_OPERATION,
  RESTORE_OPERATION,
  type RestoreResult,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { StoredFolderRestore, StoredFolderRevision } from '../folders/publish.js';
import type {
  Authorizer,
  OpaqueIdGenerator,
  StoredRestore,
  StoredRevision,
} from '../publishing/ports.js';
import {
  ArtifactNotFoundError,
  createOpaqueId,
  IdempotencyConflictError,
  InvalidPublishRequestError,
} from '../publishing/publish.js';
import { RevisionNotFoundError } from '../revisions/read.js';
import { type StoredArtifact, storedArtifactToArtifact } from './catalog.js';

type StoredLifecycleRestore = StoredRestore | StoredFolderRestore;

const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/u;
export const ARTIFACT_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const ARTIFACT_UNSHARED_GRACE_MS = 30 * 24 * 60 * 60 * 1_000;
export const ARTIFACT_RECOVERY_LEASE_MS = 7 * 24 * 60 * 60 * 1_000;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function initialArtifactNameFromFileName(originalFileName: string): string {
  const sanitized = [...originalFileName]
    .filter((character) => !containsControlCharacter(character))
    .join('')
    .trim();
  return [...(sanitized.length === 0 ? 'Untitled artifact' : sanitized)].slice(0, 255).join('');
}

export interface ArtifactLifecycleRepository {
  findArtifact(artifactId: string): Promise<StoredArtifact | undefined>;
  renameArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    name: string;
  }): Promise<StoredArtifact | undefined>;
  findRevision(revisionId: string): Promise<StoredRevision | undefined>;
  findFolderRevision?(revisionId: string): Promise<StoredFolderRevision | undefined>;
  findRestoreIdempotency(
    namespace: RestoreIdempotencyNamespace,
  ): Promise<RestoreIdempotencyRecord | undefined>;
  commitRestore(input: CommitRestoreInput): Promise<CommitRestoreOutcome>;
}

export interface StoredArtifactDeletionState {
  artifact: StoredArtifact;
  deletedAt: string | null;
  recoverableUntil: string | null;
  deletionReason: 'manual' | 'retention' | null;
}

export type DeleteArtifactOutcome =
  | {
      status: 'deleted' | 'already-deleted';
      deletedAt: string;
      recoverableUntil: string;
      reason: 'manual' | 'retention';
      revokedShareCount: number;
    }
  | { status: 'not-found' };

export type RecoverArtifactOutcome =
  | { status: 'recovered' | 'replayed'; artifact: StoredArtifact }
  | { status: 'conflict' }
  | { status: 'expired' }
  | { status: 'not-found' };

export interface ArtifactRecoveryIdempotencyNamespace {
  installationId: string;
  workspaceId: string;
  actorId: string;
  operation: typeof RECOVER_OPERATION;
  key: string;
}

export interface ArtifactDeletionRepository {
  findArtifactForDeletion(artifactId: string): Promise<StoredArtifactDeletionState | undefined>;
  deleteArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    actorId: string;
    deletedAt: string;
    recoverableUntil: string;
    reason: 'manual' | 'retention';
  }): Promise<DeleteArtifactOutcome>;
  recoverArtifact(request: {
    namespace: ArtifactRecoveryIdempotencyNamespace;
    fingerprint: string;
    artifactId: string;
    recoveredAt: string;
  }): Promise<RecoverArtifactOutcome>;
}

export interface RestoreIdempotencyNamespace {
  installationId: string;
  workspaceId: string;
  actorId: string;
  operation: typeof RESTORE_OPERATION;
  key: string;
}

export interface RestoreIdempotencyRecord {
  fingerprint: string;
  result: StoredLifecycleRestore;
  revisionNumber: number;
}

export interface CommitRestoreInput {
  namespace: RestoreIdempotencyNamespace;
  fingerprint: string;
  result: StoredLifecycleRestore;
}

export type CommitRestoreOutcome =
  | { status: 'committed' | 'replayed'; result: StoredLifecycleRestore; revisionNumber: number }
  | { status: 'conflict' };

export class InvalidArtifactNameError extends ShelfCoreError {
  constructor() {
    super('INVALID_REQUEST', 'The artifact name is invalid.', {
      retryable: false,
      details: [
        {
          field: 'name',
          reason: 'must contain 1-255 non-control characters and not be only whitespace',
        },
      ],
    });
    this.name = 'InvalidArtifactNameError';
  }
}

export class ArtifactRecoveryExpiredError extends ShelfCoreError {
  constructor() {
    super('ARTIFACT_RECOVERY_EXPIRED', 'The artifact recovery window has expired.', {
      retryable: false,
    });
    this.name = 'ArtifactRecoveryExpiredError';
  }
}

export function createArtifactRecoveryFingerprint(input: { artifactId: string }): string {
  const canonical = JSON.stringify({ version: 1, ...input });
  return `artifact-recovery-request/v1:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function validateRecoveryRequest(request: {
  installationId: string;
  actorId: string;
  artifactId: string;
  idempotencyKey: string;
}): void {
  const details: Array<{ field: string; reason: string }> = [];
  for (const [field, value] of [
    ['installationId', request.installationId],
    ['actorId', request.actorId],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value.length === 0 || value.length > 128) {
      details.push({ field, reason: 'must contain 1-128 characters' });
    }
  }
  if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
    details.push({ field: 'artifactId', reason: 'must be a valid opaque artifact ID' });
  }
  if (details.length > 0) throw new InvalidPublishRequestError(details);
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || [...name].length > 255 || containsControlCharacter(name)) {
    throw new InvalidArtifactNameError();
  }
  return name;
}

function validateRestoreRequest(request: {
  installationId: string;
  workspaceId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  artifactId: string;
  sourceRevisionId: string;
}): void {
  const details: Array<{ field: string; reason: string }> = [];
  for (const [field, value] of [
    ['installationId', request.installationId],
    ['workspaceId', request.workspaceId],
    ['actorId', request.actorId],
    ['requestId', request.requestId],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value.length === 0 || value.length > 128) {
      details.push({ field, reason: 'must contain 1-128 characters' });
    }
  }
  if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
    details.push({ field: 'artifactId', reason: 'must be a valid opaque artifact ID' });
  }
  if (!/^rev_[A-Za-z0-9_-]{22}$/u.test(request.sourceRevisionId)) {
    details.push({ field: 'sourceRevisionId', reason: 'must be a valid opaque revision ID' });
  }
  if (details.length > 0) throw new InvalidPublishRequestError(details);
}

export function createRestoreFingerprint(input: {
  artifactId: string;
  sourceRevisionId: string;
}): string {
  const canonical = JSON.stringify({ version: 1, ...input });
  return `restore-request/v1:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function restoreResult(
  stored: StoredLifecycleRestore,
  revisionNumber: number,
  requestId: string,
  replayed: boolean,
): RestoreResult {
  if (stored.kind === 'folder') {
    return {
      apiVersion: 'v1',
      kind: 'folder',
      workspaceId: stored.workspaceId,
      artifactId: stored.artifactId,
      revisionId: stored.revisionId,
      revisionNumber,
      sourceRevisionId: stored.provenance.source.revisionId,
      contentHash: stored.manifest.contentHash,
      byteCount: stored.totalByteCount,
      fileCount: stored.fileCount,
      provenance: {
        classification: 'restore',
        observed: { ...stored.provenance.observed },
        source: { ...stored.provenance.source },
      },
      requestId,
      paths: {
        artifact: `/api/v1/artifacts/${stored.artifactId}`,
        revision: `/api/v1/revisions/${stored.revisionId}`,
        tree: `/api/v1/revisions/${stored.revisionId}/tree`,
      },
      replayed,
    };
  }
  return {
    apiVersion: 'v1',
    kind: 'file',
    workspaceId: stored.workspaceId,
    artifactId: stored.artifactId,
    revisionId: stored.revisionId,
    revisionNumber,
    sourceRevisionId: stored.provenance.source.revisionId,
    contentHash: stored.content.contentHash,
    byteCount: stored.content.byteCount,
    fileCount: 1,
    provenance: {
      classification: 'restore',
      observed: { ...stored.provenance.observed },
      source: { ...stored.provenance.source },
    },
    requestId,
    paths: {
      artifact: `/api/v1/artifacts/${stored.artifactId}`,
      revision: `/api/v1/revisions/${stored.revisionId}`,
      content: `/api/v1/revisions/${stored.revisionId}/content`,
    },
    replayed,
  };
}

export function createArtifactLifecycleService(dependencies: {
  authorizer: Authorizer;
  artifacts: ArtifactLifecycleRepository;
  deletions?: ArtifactDeletionRepository;
  generateId?: OpaqueIdGenerator;
  clock?: () => Date;
}) {
  const generateId = dependencies.generateId ?? createOpaqueId;
  const clock = dependencies.clock ?? (() => new Date());

  function deletionRepository(): ArtifactDeletionRepository {
    if (dependencies.deletions !== undefined) return dependencies.deletions;
    throw boundaryFailure(
      'SERVICE_UNAVAILABLE',
      'Artifact lifecycle storage is unavailable.',
      new Error('Artifact deletion repository is not configured.'),
    );
  }

  async function deletionState(request: {
    installationId: string;
    actorId: string;
    artifactId: string;
    signal?: AbortSignal;
  }): Promise<StoredArtifactDeletionState> {
    if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) throw new ArtifactNotFoundError();
    const deletions = deletionRepository();
    let state: StoredArtifactDeletionState | undefined;
    try {
      request.signal?.throwIfAborted();
      state = await deletions.findArtifactForDeletion(request.artifactId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
    }
    if (
      state === undefined ||
      state.artifact.artifactId !== request.artifactId ||
      state.artifact.installationId !== request.installationId
    ) {
      throw new ArtifactNotFoundError();
    }
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: state.artifact.workspaceId,
        actorId: request.actorId,
        action: PUBLISH_OPERATION,
      },
      request.signal,
    );
    request.signal?.throwIfAborted();
    return state;
  }

  return {
    async deleteArtifact(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      signal?: AbortSignal;
    }): Promise<ArtifactDeletionResult> {
      const state = await deletionState(request);
      const now = clock();
      const deletedAt = now.toISOString();
      const recoverableUntil = new Date(now.getTime() + ARTIFACT_RECOVERY_WINDOW_MS).toISOString();
      let outcome: DeleteArtifactOutcome;
      try {
        outcome = await deletionRepository().deleteArtifact({
          installationId: request.installationId,
          workspaceId: state.artifact.workspaceId,
          artifactId: request.artifactId,
          actorId: request.actorId,
          deletedAt,
          recoverableUntil,
          reason: 'manual',
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact deletion failed.', error);
      }
      if (outcome.status === 'not-found') throw new ArtifactNotFoundError();
      return {
        apiVersion: 'v1',
        workspaceId: state.artifact.workspaceId,
        artifactId: request.artifactId,
        deletedAt: outcome.deletedAt,
        recoverableUntil: outcome.recoverableUntil,
        reason: outcome.reason,
        revokedShareCount: outcome.revokedShareCount,
      };
    },

    async recoverArtifact(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      idempotencyKey: string;
      signal?: AbortSignal;
    }): Promise<Artifact> {
      validateRecoveryRequest(request);
      const state = await deletionState(request);
      const namespace: ArtifactRecoveryIdempotencyNamespace = {
        installationId: request.installationId,
        workspaceId: state.artifact.workspaceId,
        actorId: request.actorId,
        operation: RECOVER_OPERATION,
        key: request.idempotencyKey,
      };
      let outcome: RecoverArtifactOutcome;
      try {
        request.signal?.throwIfAborted();
        outcome = await deletionRepository().recoverArtifact({
          namespace,
          fingerprint: createArtifactRecoveryFingerprint({ artifactId: request.artifactId }),
          artifactId: request.artifactId,
          recoveredAt: clock().toISOString(),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact recovery failed.', error);
      }
      if (outcome.status === 'expired') throw new ArtifactRecoveryExpiredError();
      if (outcome.status === 'not-found') throw new ArtifactNotFoundError();
      if (outcome.status === 'conflict') throw new IdempotencyConflictError();
      if (
        outcome.artifact.artifactId !== request.artifactId ||
        outcome.artifact.installationId !== request.installationId ||
        outcome.artifact.workspaceId !== state.artifact.workspaceId
      ) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Artifact recovery returned invalid scope.',
          new Error('Artifact recovery adapter crossed its requested scope.'),
        );
      }
      return storedArtifactToArtifact(outcome.artifact);
    },

    async renameArtifact(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      name: string;
      signal?: AbortSignal;
    }): Promise<Artifact> {
      const name = normalizeName(request.name);
      let stored: StoredArtifact | undefined;
      try {
        request.signal?.throwIfAborted();
        stored = await dependencies.artifacts.findArtifact(request.artifactId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
      }
      if (
        stored === undefined ||
        stored.artifactId !== request.artifactId ||
        stored.installationId !== request.installationId
      ) {
        throw new ArtifactNotFoundError();
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: stored.workspaceId,
          actorId: request.actorId,
          action: PUBLISH_OPERATION,
        },
        request.signal,
      );
      request.signal?.throwIfAborted();
      let renamed: StoredArtifact | undefined;
      try {
        renamed = await dependencies.artifacts.renameArtifact({
          installationId: request.installationId,
          workspaceId: stored.workspaceId,
          artifactId: request.artifactId,
          name,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact rename failed.', error);
      }
      if (
        renamed === undefined ||
        renamed.artifactId !== request.artifactId ||
        renamed.installationId !== request.installationId ||
        renamed.workspaceId !== stored.workspaceId
      ) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Artifact rename returned invalid scope.',
          new Error('Artifact lifecycle adapter crossed its requested scope.'),
        );
      }
      return storedArtifactToArtifact(renamed);
    },

    async restoreArtifact(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      artifactId: string;
      sourceRevisionId: string;
      idempotencyKey: string;
      requestId: string;
      signal?: AbortSignal;
    }): Promise<RestoreResult> {
      validateRestoreRequest(request);
      let artifact: StoredArtifact | undefined;
      try {
        request.signal?.throwIfAborted();
        artifact = await dependencies.artifacts.findArtifact(request.artifactId);
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

      let source: StoredRevision | StoredFolderRevision | undefined;
      try {
        source =
          artifact.kind === 'folder'
            ? await dependencies.artifacts.findFolderRevision?.(request.sourceRevisionId)
            : await dependencies.artifacts.findRevision(request.sourceRevisionId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision lookup failed.', error);
      }
      if (
        source === undefined ||
        source.revisionId !== request.sourceRevisionId ||
        source.installationId !== request.installationId ||
        source.workspaceId !== request.workspaceId ||
        source.artifactId !== request.artifactId
      ) {
        throw new RevisionNotFoundError();
      }

      const namespace: RestoreIdempotencyNamespace = {
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        operation: RESTORE_OPERATION,
        key: request.idempotencyKey,
      };
      const fingerprint = createRestoreFingerprint({
        artifactId: request.artifactId,
        sourceRevisionId: request.sourceRevisionId,
      });
      let existing: RestoreIdempotencyRecord | undefined;
      try {
        existing = await dependencies.artifacts.findRestoreIdempotency(namespace);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Idempotency lookup failed.', error);
      }
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
        return restoreResult(existing.result, existing.revisionNumber, request.requestId, true);
      }

      const revisionId = generateId('rev');
      const stored: StoredLifecycleRestore =
        source.kind === 'folder'
          ? Object.freeze({
              apiVersion: 'v1',
              kind: 'folder',
              installationId: request.installationId,
              workspaceId: request.workspaceId,
              artifactId: request.artifactId,
              revisionId,
              manifest: Object.freeze({ ...source.manifest }),
              rootName: source.rootName,
              totalByteCount: source.totalByteCount,
              fileCount: source.fileCount,
              provenance: Object.freeze({
                classification: 'restore',
                observed: Object.freeze({ actorId: request.actorId, operation: RESTORE_OPERATION }),
                source: Object.freeze({ revisionId: source.revisionId }),
              }),
              publisherMetadata: Object.freeze({ ...source.publisherMetadata }),
            })
          : Object.freeze({
              apiVersion: 'v1',
              kind: 'file',
              installationId: request.installationId,
              workspaceId: request.workspaceId,
              artifactId: request.artifactId,
              revisionId,
              content: Object.freeze({ ...source.content }),
              originalFileName: source.originalFileName,
              mediaType: source.mediaType,
              provenance: Object.freeze({
                classification: 'restore',
                observed: Object.freeze({ actorId: request.actorId, operation: RESTORE_OPERATION }),
                source: Object.freeze({ revisionId: source.revisionId }),
              }),
              publisherMetadata: Object.freeze({ ...source.publisherMetadata }),
            });

      let outcome: CommitRestoreOutcome;
      try {
        request.signal?.throwIfAborted();
        outcome = await dependencies.artifacts.commitRestore({
          namespace,
          fingerprint,
          result: stored,
        });
      } catch (error) {
        if (error instanceof ShelfCoreError) throw error;
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision restore failed.', error);
      }
      request.signal?.throwIfAborted();
      if (outcome.status === 'conflict') throw new IdempotencyConflictError();
      return restoreResult(
        outcome.result,
        outcome.revisionNumber,
        request.requestId,
        outcome.status === 'replayed',
      );
    },
  };
}
