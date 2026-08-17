import type {
  ArtifactCatalogRepository,
  ArtifactLifecycleRepository,
  CommitPublishInput,
  CommitPublishOutcome,
  CommitRestoreInput,
  CommitRestoreOutcome,
  IdempotencyNamespace,
  IdempotencyRecord,
  RestoreIdempotencyNamespace,
  RestoreIdempotencyRecord,
  RevisionRepository,
  StoredArtifact,
  StoredArtifactRevision,
  StoredRestore,
  StoredRevision,
} from '@shelf/core';
import { initialArtifactNameFromFileName } from '@shelf/core';

function namespaceKey(namespace: {
  installationId: string;
  workspaceId: string;
  actorId: string;
  operation: string;
  key: string;
}): string {
  return [
    namespace.installationId,
    namespace.workspaceId,
    namespace.actorId,
    namespace.operation,
    namespace.key,
  ].join('\u0000');
}

/** Process-local validation adapter. It deliberately does not settle Shelf's persistence model. */
export class MemoryRevisionRepository
  implements RevisionRepository, ArtifactCatalogRepository, ArtifactLifecycleRepository
{
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #artifactRevisions = new Map<string, StoredArtifactRevision[]>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #restoreIdempotency = new Map<string, RestoreIdempotencyRecord>();
  readonly #revisions = new Map<string, StoredRevision>();

  async findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return this.#idempotency.get(namespaceKey(namespace));
  }

  async commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome> {
    // This method has no suspension point. JavaScript's run-to-completion rule makes the read and
    // both writes one process-local linearization point for concurrent callers.
    const key = namespaceKey(input.namespace);
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? { status: 'replayed', result: existing.result }
        : { status: 'conflict' };
    }

    const record = Object.freeze({ fingerprint: input.fingerprint, result: input.result });
    const previous = this.#artifacts.get(input.result.artifactId);
    if (
      previous !== undefined &&
      (previous.installationId !== input.result.installationId ||
        previous.workspaceId !== input.result.workspaceId)
    ) {
      throw new Error('Artifact identity belongs to another workspace.');
    }
    const history = this.#artifactRevisions.get(input.result.artifactId) ?? [];
    const createdAt = new Date().toISOString();
    const revision: StoredArtifactRevision = {
      revisionId: input.result.revisionId,
      revisionNumber: history.length + 1,
      originalFileName: input.result.originalFileName,
      mediaType: input.result.mediaType,
      contentHash: input.result.content.contentHash,
      byteCount: input.result.content.byteCount,
      createdAt,
      provenance: input.result.provenance,
      publisherMetadata: input.result.publisherMetadata,
    };
    this.#artifactRevisions.set(input.result.artifactId, [...history, revision]);
    this.#artifacts.set(input.result.artifactId, {
      installationId: input.result.installationId,
      workspaceId: input.result.workspaceId,
      artifactId: input.result.artifactId,
      name: previous?.name ?? initialArtifactNameFromFileName(input.result.originalFileName),
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      latestRevision: revision,
    });
    this.#revisions.set(input.result.revisionId, input.result);
    this.#idempotency.set(key, record);
    return { status: 'committed', result: input.result };
  }

  async findRevision(revisionId: string): Promise<StoredRevision | undefined> {
    return this.#revisions.get(revisionId);
  }

  async findArtifactIdentity(artifactId: string) {
    const artifact = this.#artifacts.get(artifactId);
    return artifact === undefined
      ? undefined
      : {
          artifactId: artifact.artifactId,
          installationId: artifact.installationId,
          workspaceId: artifact.workspaceId,
        };
  }

  async findArtifact(artifactId: string): Promise<StoredArtifact | undefined> {
    return this.#artifacts.get(artifactId);
  }

  async renameArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    name: string;
  }): Promise<StoredArtifact | undefined> {
    const artifact = this.#artifacts.get(request.artifactId);
    if (
      artifact === undefined ||
      artifact.installationId !== request.installationId ||
      artifact.workspaceId !== request.workspaceId
    ) {
      return undefined;
    }
    const renamed = { ...artifact, name: request.name, updatedAt: new Date().toISOString() };
    this.#artifacts.set(request.artifactId, renamed);
    return renamed;
  }

  async findRestoreIdempotency(
    namespace: RestoreIdempotencyNamespace,
  ): Promise<RestoreIdempotencyRecord | undefined> {
    return this.#restoreIdempotency.get(namespaceKey(namespace));
  }

  async commitRestore(input: CommitRestoreInput): Promise<CommitRestoreOutcome> {
    const key = namespaceKey(input.namespace);
    const existing = this.#restoreIdempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? {
            status: 'replayed',
            result: existing.result,
            revisionNumber: existing.revisionNumber,
          }
        : { status: 'conflict' };
    }
    const artifact = this.#artifacts.get(input.result.artifactId);
    const source = this.#revisions.get(input.result.provenance.source.revisionId);
    if (
      artifact === undefined ||
      source === undefined ||
      artifact.installationId !== input.result.installationId ||
      artifact.workspaceId !== input.result.workspaceId ||
      source.installationId !== input.result.installationId ||
      source.workspaceId !== input.result.workspaceId ||
      source.artifactId !== input.result.artifactId
    ) {
      throw new Error('Restore identity is invalid.');
    }
    const history = this.#artifactRevisions.get(input.result.artifactId) ?? [];
    const createdAt = new Date().toISOString();
    const result: StoredRestore = {
      ...input.result,
      content: { ...source.content },
      originalFileName: source.originalFileName,
      mediaType: source.mediaType,
      publisherMetadata: { ...source.publisherMetadata },
    };
    const revisionNumber = history.length + 1;
    const revision: StoredArtifactRevision = {
      revisionId: result.revisionId,
      revisionNumber,
      originalFileName: result.originalFileName,
      mediaType: result.mediaType,
      contentHash: result.content.contentHash,
      byteCount: result.content.byteCount,
      createdAt,
      provenance: result.provenance,
      publisherMetadata: result.publisherMetadata,
    };
    this.#artifactRevisions.set(result.artifactId, [...history, revision]);
    this.#artifacts.set(result.artifactId, {
      ...artifact,
      updatedAt: createdAt,
      latestRevision: revision,
    });
    this.#revisions.set(result.revisionId, result);
    this.#restoreIdempotency.set(key, { fingerprint: input.fingerprint, result, revisionNumber });
    return { status: 'committed', result, revisionNumber };
  }

  async listArtifacts(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { updatedAt: string; artifactId: string };
  }) {
    const ordered = [...this.#artifacts.values()]
      .filter(
        (artifact) =>
          artifact.installationId === request.installationId &&
          artifact.workspaceId === request.workspaceId,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.artifactId.localeCompare(right.artifactId),
      )
      .filter((artifact) => {
        if (request.after === undefined) return true;
        return (
          artifact.updatedAt < request.after.updatedAt ||
          (artifact.updatedAt === request.after.updatedAt &&
            artifact.artifactId > request.after.artifactId)
        );
      });
    const hasMore = ordered.length > request.limit;
    const items = ordered.slice(0, request.limit);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? { next: { updatedAt: last.updatedAt, artifactId: last.artifactId } }
        : {}),
    };
  }

  async listArtifactRevisions(request: {
    installationId: string;
    artifactId: string;
    limit: number;
    beforeRevisionNumber?: number;
  }) {
    const artifact = this.#artifacts.get(request.artifactId);
    if (artifact === undefined || artifact.installationId !== request.installationId) {
      return { items: [] };
    }
    const ordered = [...(this.#artifactRevisions.get(request.artifactId) ?? [])]
      .filter(
        (revision) =>
          request.beforeRevisionNumber === undefined ||
          revision.revisionNumber < request.beforeRevisionNumber,
      )
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    const hasMore = ordered.length > request.limit;
    const items = ordered.slice(0, request.limit);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { nextRevisionNumber: last.revisionNumber } : {}),
    };
  }
}
