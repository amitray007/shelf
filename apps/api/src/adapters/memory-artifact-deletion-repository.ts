import type {
  ArtifactDeletionRepository,
  ArtifactRecoveryIdempotencyNamespace,
  DeleteArtifactOutcome,
  RecoverArtifactOutcome,
  StoredArtifact,
  StoredArtifactDeletionState,
} from '@shelf/core';

import type { MemoryRevisionRepository } from './memory-revision-repository.js';
import type { MemoryShareRepository } from './memory-share-repository.js';

/** Process-local coordinator used only by the injectable development/test assembly. */
export class MemoryArtifactDeletionRepository implements ArtifactDeletionRepository {
  readonly #artifacts: MemoryRevisionRepository;
  readonly #shares: MemoryShareRepository;
  readonly #recoveryIdempotency = new Map<
    string,
    { fingerprint: string; artifact: StoredArtifact }
  >();

  constructor(artifacts: MemoryRevisionRepository, shares: MemoryShareRepository) {
    this.#artifacts = artifacts;
    this.#shares = shares;
  }

  async findArtifactForDeletion(
    artifactId: string,
  ): Promise<StoredArtifactDeletionState | undefined> {
    const state = this.#artifacts.findArtifactDeletionState(artifactId);
    return state === undefined
      ? undefined
      : {
          artifact: state.artifact,
          deletedAt: state.deletedAt,
          recoverableUntil: state.recoverableUntil,
        };
  }

  async deleteArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    actorId: string;
    deletedAt: string;
    recoverableUntil: string;
  }): Promise<DeleteArtifactOutcome> {
    const state = this.#artifacts.findArtifactDeletionState(request.artifactId);
    if (
      state === undefined ||
      state.artifact.installationId !== request.installationId ||
      state.artifact.workspaceId !== request.workspaceId
    ) {
      return { status: 'not-found' };
    }
    if (
      state.deletedAt !== null &&
      state.recoverableUntil !== null &&
      state.revokedShareCount !== null
    ) {
      return {
        status: 'already-deleted',
        deletedAt: state.deletedAt,
        recoverableUntil: state.recoverableUntil,
        revokedShareCount: state.revokedShareCount,
      };
    }
    const revokedShareCount = this.#shares.revokeActiveArtifactShares({
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      artifactId: request.artifactId,
      actorId: request.actorId,
      revokedAt: request.deletedAt,
    });
    const deletion = this.#artifacts.markArtifactDeleted({
      ...request,
      revokedShareCount,
    });
    if (deletion === undefined) return { status: 'not-found' };
    return { status: 'deleted', ...deletion };
  }

  async recoverArtifact(request: {
    namespace: ArtifactRecoveryIdempotencyNamespace;
    fingerprint: string;
    artifactId: string;
    recoveredAt: string;
  }): Promise<RecoverArtifactOutcome> {
    const key = [
      request.namespace.installationId,
      request.namespace.workspaceId,
      request.namespace.actorId,
      request.namespace.operation,
      request.namespace.key,
    ].join('\u0000');
    const existing = this.#recoveryIdempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === request.fingerprint
        ? { status: 'replayed', artifact: structuredClone(existing.artifact) }
        : { status: 'conflict' };
    }
    const outcome = this.#artifacts.recoverArtifactState({
      installationId: request.namespace.installationId,
      workspaceId: request.namespace.workspaceId,
      artifactId: request.artifactId,
      recoveredAt: request.recoveredAt,
    });
    if (outcome.status === 'recovered') {
      this.#recoveryIdempotency.set(key, {
        fingerprint: request.fingerprint,
        artifact: structuredClone(outcome.artifact),
      });
    }
    return outcome;
  }
}
