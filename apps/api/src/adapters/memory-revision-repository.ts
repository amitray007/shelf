import type {
  ArtifactCatalogRepository,
  ArtifactLifecycleRepository,
  CommitFolderPublishInput,
  CommitFolderPublishOutcome,
  CommitPublishInput,
  CommitPublishOutcome,
  CommitRestoreInput,
  CommitRestoreOutcome,
  FolderIdempotencyRecord,
  FolderRevisionRepository,
  IdempotencyNamespace,
  IdempotencyRecord,
  RestoreIdempotencyNamespace,
  RestoreIdempotencyRecord,
  RevisionRepository,
  StoredArtifact,
  StoredArtifactRevision,
  StoredFolderEntry,
  StoredFolderRestore,
  StoredFolderRevision,
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
  implements
    RevisionRepository,
    ArtifactCatalogRepository,
    ArtifactLifecycleRepository,
    FolderRevisionRepository
{
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #artifactRevisions = new Map<string, StoredArtifactRevision[]>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #folderIdempotency = new Map<string, FolderIdempotencyRecord>();
  readonly #folderRevisions = new Map<string, StoredFolderRevision>();
  readonly #folderEntries = new Map<string, readonly StoredFolderEntry[]>();
  readonly #restoreIdempotency = new Map<string, RestoreIdempotencyRecord>();
  readonly #revisions = new Map<string, StoredRevision>();

  async findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return this.#idempotency.get(namespaceKey(namespace));
  }

  async commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome> {
    // This method has no suspension point. JavaScript's run-to-completion rule makes the read and
    // both writes one process-local linearization point for concurrent callers.
    const key = namespaceKey(input.namespace);
    if (this.#folderIdempotency.has(key)) return { status: 'conflict' };
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint && existing.result !== undefined
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
      kind: 'file',
      name: previous?.name ?? initialArtifactNameFromFileName(input.result.originalFileName),
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      latestRevision: revision,
    });
    this.#revisions.set(input.result.revisionId, input.result);
    this.#idempotency.set(key, record);
    return { status: 'committed', result: input.result };
  }

  async findFolderIdempotency(
    namespace: IdempotencyNamespace,
  ): Promise<FolderIdempotencyRecord | undefined> {
    const key = namespaceKey(namespace);
    return (
      this.#folderIdempotency.get(key) ??
      (this.#idempotency.has(key)
        ? { fingerprint: this.#idempotency.get(key)?.fingerprint ?? '' }
        : undefined)
    );
  }

  async commitFolderPublish(input: CommitFolderPublishInput): Promise<CommitFolderPublishOutcome> {
    const key = namespaceKey(input.namespace);
    const existing = await this.findFolderIdempotency(input.namespace);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint && existing.result !== undefined
        ? { status: 'replayed', result: existing.result }
        : { status: 'conflict' };
    }
    const previous = this.#artifacts.get(input.result.artifactId);
    if (
      previous !== undefined &&
      (previous.installationId !== input.result.installationId ||
        previous.workspaceId !== input.result.workspaceId ||
        previous.kind !== 'folder')
    ) {
      throw new Error('Folder artifact identity is invalid.');
    }
    const history = this.#artifactRevisions.get(input.result.artifactId) ?? [];
    const createdAt = new Date().toISOString();
    const revision: StoredArtifactRevision = {
      kind: 'folder',
      revisionId: input.result.revisionId,
      revisionNumber: history.length + 1,
      rootName: input.result.rootName,
      contentHash: input.result.manifest.contentHash,
      byteCount: input.result.totalByteCount,
      fileCount: input.result.fileCount,
      createdAt,
      provenance: input.result.provenance,
      publisherMetadata: input.result.publisherMetadata,
    };
    this.#artifactRevisions.set(input.result.artifactId, [...history, revision]);
    this.#artifacts.set(input.result.artifactId, {
      installationId: input.result.installationId,
      workspaceId: input.result.workspaceId,
      artifactId: input.result.artifactId,
      kind: 'folder',
      name: previous?.name ?? initialArtifactNameFromFileName(input.result.rootName),
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      latestRevision: revision,
    });
    this.#folderRevisions.set(input.result.revisionId, input.result);
    this.#folderEntries.set(input.result.revisionId, [...input.entries]);
    this.#folderIdempotency.set(key, {
      fingerprint: input.fingerprint,
      result: input.result,
    });
    return { status: 'committed', result: input.result };
  }

  async findFolderRevision(revisionId: string): Promise<StoredFolderRevision | undefined> {
    return this.#folderRevisions.get(revisionId);
  }

  async listFolderEntries(request: {
    installationId: string;
    revisionId: string;
    limit: number;
    afterPath?: string;
  }) {
    const revision = this.#folderRevisions.get(request.revisionId);
    if (revision === undefined || revision.installationId !== request.installationId) {
      return { items: [] };
    }
    const ordered = [...(this.#folderEntries.get(request.revisionId) ?? [])]
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
      .filter((entry) => request.afterPath === undefined || entry.path > request.afterPath);
    const hasMore = ordered.length > request.limit;
    const items = ordered.slice(0, request.limit);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { nextPath: last.path } : {}),
    };
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
          ...(artifact.kind === undefined ? {} : { kind: artifact.kind }),
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
    const source =
      input.result.kind === 'folder'
        ? this.#folderRevisions.get(input.result.provenance.source.revisionId)
        : this.#revisions.get(input.result.provenance.source.revisionId);
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
    if (input.result.kind === 'folder') {
      if (source.kind !== 'folder' || artifact.kind !== 'folder') {
        throw new Error('Folder restore identity is invalid.');
      }
      const result: StoredFolderRestore = {
        ...input.result,
        manifest: { ...source.manifest },
        rootName: source.rootName,
        totalByteCount: source.totalByteCount,
        fileCount: source.fileCount,
        publisherMetadata: { ...source.publisherMetadata },
      };
      const revisionNumber = history.length + 1;
      const revision: StoredArtifactRevision = {
        kind: 'folder',
        revisionId: result.revisionId,
        revisionNumber,
        rootName: result.rootName,
        contentHash: result.manifest.contentHash,
        byteCount: result.totalByteCount,
        fileCount: result.fileCount,
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
      this.#folderRevisions.set(result.revisionId, result);
      this.#folderEntries.set(result.revisionId, [
        ...(this.#folderEntries.get(source.revisionId) ?? []),
      ]);
      this.#restoreIdempotency.set(key, { fingerprint: input.fingerprint, result, revisionNumber });
      return { status: 'committed', result, revisionNumber };
    }
    if (source.kind === 'folder') throw new Error('File restore identity is invalid.');
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
