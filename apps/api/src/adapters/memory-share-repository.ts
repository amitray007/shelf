import type {
  ArtifactCatalogRepository,
  CommitShareCreateInput,
  CommitShareCreateOutcome,
  FolderRevisionRepository,
  ResolvedStoredShare,
  RevisionRepository,
  RevokeShareOutcome,
  ShareCreateIdempotencyNamespace,
  ShareCreateIdempotencyRecord,
  ShareRepository,
  StoredArtifactRevision,
  StoredShare,
  StoredShareRevision,
} from '@shelf/core';

type ShareRevisionSource = RevisionRepository &
  ArtifactCatalogRepository &
  FolderRevisionRepository;

function namespaceKey(namespace: ShareCreateIdempotencyNamespace): string {
  return [
    namespace.installationId,
    namespace.workspaceId,
    namespace.actorId,
    namespace.operation,
    namespace.key,
  ].join('\u0000');
}

function copyShare(value: StoredShare): StoredShare {
  return structuredClone(value);
}

/** Process-local share adapter. Every mutation has one synchronous linearization point. */
export class MemoryShareRepository implements ShareRepository {
  readonly #source: ShareRevisionSource;
  readonly #shares = new Map<string, StoredShare>();
  readonly #idempotency = new Map<string, ShareCreateIdempotencyRecord>();

  constructor(source: ShareRevisionSource) {
    this.#source = source;
  }

  async findArtifactForShare(artifactId: string) {
    return this.#source.findArtifact(artifactId);
  }

  async findRevisionForShare(revisionId: string): Promise<StoredShareRevision | undefined> {
    const file = await this.#source.findRevision(revisionId);
    const folder =
      file === undefined ? await this.#source.findFolderRevision(revisionId) : undefined;
    const stored = file ?? folder;
    if (stored === undefined) return undefined;
    const artifact = await this.#source.findArtifact(stored.artifactId);
    if (
      artifact === undefined ||
      artifact.installationId !== stored.installationId ||
      artifact.workspaceId !== stored.workspaceId
    ) {
      return undefined;
    }
    let descriptor: StoredArtifactRevision | undefined;
    if (artifact.latestRevision.revisionId === revisionId) {
      descriptor = artifact.latestRevision;
    } else {
      let beforeRevisionNumber: number | undefined;
      do {
        const page = await this.#source.listArtifactRevisions({
          installationId: stored.installationId,
          artifactId: stored.artifactId,
          limit: 100,
          ...(beforeRevisionNumber === undefined ? {} : { beforeRevisionNumber }),
        });
        descriptor = page.items.find((candidate) => candidate.revisionId === revisionId);
        if (descriptor !== undefined || page.nextRevisionNumber === undefined) break;
        beforeRevisionNumber = page.nextRevisionNumber;
      } while (descriptor === undefined);
    }
    if (descriptor === undefined) return undefined;
    return {
      installationId: stored.installationId,
      workspaceId: stored.workspaceId,
      artifactId: stored.artifactId,
      revision: structuredClone(descriptor),
    };
  }

  async findCreateIdempotency(
    namespace: ShareCreateIdempotencyNamespace,
  ): Promise<ShareCreateIdempotencyRecord | undefined> {
    const record = this.#idempotency.get(namespaceKey(namespace));
    return record === undefined
      ? undefined
      : { fingerprint: record.fingerprint, result: copyShare(record.result) };
  }

  async commitCreate(input: CommitShareCreateInput): Promise<CommitShareCreateOutcome> {
    const key = namespaceKey(input.namespace);
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? { status: 'replayed', result: copyShare(existing.result) }
        : { status: 'conflict' };
    }
    if (this.#shares.has(input.result.shareId)) {
      throw new Error('Share ID collision.');
    }
    const stored = copyShare(input.result);
    this.#shares.set(stored.shareId, stored);
    this.#idempotency.set(key, { fingerprint: input.fingerprint, result: stored });
    return { status: 'committed', result: copyShare(stored) };
  }

  async listShares(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { createdAt: string; shareId: string };
  }) {
    const ordered = [...this.#shares.values()]
      .filter(
        (share) =>
          share.installationId === request.installationId &&
          share.workspaceId === request.workspaceId,
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.shareId.localeCompare(right.shareId),
      )
      .filter((share) => {
        if (request.after === undefined) return true;
        return (
          share.createdAt < request.after.createdAt ||
          (share.createdAt === request.after.createdAt && share.shareId > request.after.shareId)
        );
      });
    const hasMore = ordered.length > request.limit;
    const items = ordered.slice(0, request.limit).map(copyShare);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? { next: { createdAt: last.createdAt, shareId: last.shareId } }
        : {}),
    };
  }

  async findShare(shareId: string): Promise<StoredShare | undefined> {
    const stored = this.#shares.get(shareId);
    return stored === undefined ? undefined : copyShare(stored);
  }

  async revokeShare(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    revokedByActorId: string;
    revokedAt: string;
  }): Promise<RevokeShareOutcome> {
    const stored = this.#shares.get(request.shareId);
    if (
      stored === undefined ||
      stored.installationId !== request.installationId ||
      stored.workspaceId !== request.workspaceId
    ) {
      return { status: 'not-found' };
    }
    if (stored.revokedAt !== null) {
      return { status: 'already-revoked', result: copyShare(stored) };
    }
    const revoked: StoredShare = {
      ...stored,
      revokedAt: request.revokedAt,
      revokedByActorId: request.revokedByActorId,
    };
    this.#shares.set(revoked.shareId, revoked);
    for (const [key, record] of this.#idempotency) {
      if (record.result.shareId === revoked.shareId) {
        this.#idempotency.set(key, { fingerprint: record.fingerprint, result: revoked });
      }
    }
    return { status: 'revoked', result: copyShare(revoked) };
  }

  async resolveShareTarget(shareId: string): Promise<ResolvedStoredShare | undefined> {
    const share = this.#shares.get(shareId);
    if (share === undefined) return undefined;
    const artifact = await this.#source.findArtifact(share.artifactId);
    if (artifact === undefined) return undefined;
    const revision =
      share.target.mode === 'latest'
        ? {
            installationId: artifact.installationId,
            workspaceId: artifact.workspaceId,
            artifactId: artifact.artifactId,
            revision: structuredClone(artifact.latestRevision),
          }
        : await this.findRevisionForShare(share.target.revisionId);
    if (revision === undefined) return undefined;
    return {
      share: copyShare(share),
      artifact: structuredClone(artifact),
      revision,
    };
  }
}
