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
import { ArtifactNotFoundError } from '@shelf/core';

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

  #storeRevokedShare(
    stored: StoredShare,
    revokedAt: string,
    revokedByActorId: string,
  ): StoredShare {
    const revoked = { ...stored, revokedAt, revokedByActorId };
    this.#shares.set(revoked.shareId, revoked);
    return revoked;
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
      let cursorRevisionNumber: number | undefined;
      do {
        const page = await this.#source.listArtifactRevisions({
          installationId: stored.installationId,
          artifactId: stored.artifactId,
          limit: 100,
          order: 'newest',
          ...(cursorRevisionNumber === undefined ? {} : { cursorRevisionNumber }),
        });
        descriptor = page.items.find((candidate) => candidate.revisionId === revisionId);
        if (descriptor !== undefined || page.nextRevisionNumber === undefined) break;
        cursorRevisionNumber = page.nextRevisionNumber;
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
    const artifact = await this.#source.findArtifact(input.result.artifactId);
    if (
      artifact === undefined ||
      artifact.installationId !== input.result.installationId ||
      artifact.workspaceId !== input.result.workspaceId
    ) {
      throw new ArtifactNotFoundError();
    }
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
    const revoked = this.#storeRevokedShare(stored, request.revokedAt, request.revokedByActorId);
    for (const [key, record] of this.#idempotency) {
      if (record.result.shareId === revoked.shareId) {
        this.#idempotency.set(key, { fingerprint: record.fingerprint, result: revoked });
      }
    }
    return { status: 'revoked', result: copyShare(revoked) };
  }

  revokeActiveArtifactShares(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    actorId: string;
    revokedAt: string;
  }): number {
    let count = 0;
    const revokedAt = Date.parse(request.revokedAt);
    const revokedByShareId = new Map<string, StoredShare>();
    for (const stored of this.#shares.values()) {
      const expiresAt = stored.expiresAt === null ? null : Date.parse(stored.expiresAt);
      if (
        stored.installationId !== request.installationId ||
        stored.workspaceId !== request.workspaceId ||
        stored.artifactId !== request.artifactId ||
        stored.revokedAt !== null ||
        (expiresAt !== null && expiresAt <= revokedAt)
      ) {
        continue;
      }
      const revoked = this.#storeRevokedShare(stored, request.revokedAt, request.actorId);
      revokedByShareId.set(revoked.shareId, revoked);
      count += 1;
    }
    for (const [key, record] of this.#idempotency) {
      const revoked = revokedByShareId.get(record.result.shareId);
      if (revoked !== undefined) {
        this.#idempotency.set(key, { fingerprint: record.fingerprint, result: revoked });
      }
    }
    return count;
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
