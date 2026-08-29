import type {
  ArtifactCatalogRepository,
  CommitShareCreateInput,
  CommitShareCreateOutcome,
  EstablishProtectedSessionOutcome,
  FolderRevisionRepository,
  ProtectedSessionEstablishment,
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
  const copy = structuredClone(value);
  copy.commentPolicy ??= 'off';
  copy.revisionAccess ??= 'target-only';
  copy.historyFromRevisionNumber ??= null;
  return copy;
}

/** Process-local share adapter. Every mutation has one synchronous linearization point. */
export class MemoryShareRepository implements ShareRepository {
  readonly #source: ShareRevisionSource;
  readonly #shares = new Map<string, StoredShare>();
  readonly #defaultShareIds = new Set<string>();
  readonly #idempotency = new Map<string, ShareCreateIdempotencyRecord>();
  readonly #sessionReceipts = new Map<string, ProtectedSessionEstablishment>();

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

  async rewriteCreateIdempotencyFingerprint(request: {
    namespace: ShareCreateIdempotencyNamespace;
    fingerprint: string;
  }): Promise<void> {
    const key = namespaceKey(request.namespace);
    const record = this.#idempotency.get(key);
    if (record !== undefined)
      this.#idempotency.set(key, { ...record, fingerprint: request.fingerprint });
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
    if (
      input.result.accessType === 'public' &&
      input.result.publicCode !== null &&
      [...this.#shares.values()].some((share) => share.publicCode === input.result.publicCode)
    ) {
      return { status: 'public-code-conflict' };
    }
    if (
      input.purpose === 'artifact-default' &&
      [...this.#defaultShareIds].some((shareId) => {
        const share = this.#shares.get(shareId);
        return (
          share !== undefined &&
          share.installationId === input.result.installationId &&
          share.workspaceId === input.result.workspaceId &&
          share.artifactId === input.result.artifactId &&
          share.accessType === input.result.accessType &&
          share.revokedAt === null
        );
      })
    ) {
      return { status: 'default-conflict' };
    }
    const stored = copyShare(input.result);
    this.#shares.set(stored.shareId, stored);
    if (input.purpose === 'artifact-default') this.#defaultShareIds.add(stored.shareId);
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

  async findArtifactDefaultShares(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
  }) {
    const canonical = [...this.#shares.values()].filter(
      (share) =>
        share.installationId === request.installationId &&
        share.workspaceId === request.workspaceId &&
        share.artifactId === request.artifactId &&
        this.#defaultShareIds.has(share.shareId) &&
        share.target.mode === 'latest' &&
        share.expiresAt === null &&
        share.maxSessions === null,
    );
    const active = canonical
      .filter((share) => share.revokedAt === null)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.shareId.localeCompare(right.shareId),
      );
    const protectedShare = active.find((share) => share.accessType === 'protected');
    const publicShare = active.find((share) => share.accessType === 'public');
    return {
      ...(protectedShare === undefined ? {} : { protected: copyShare(protectedShare) }),
      ...(publicShare === undefined ? {} : { public: copyShare(publicShare) }),
      generations: {
        protected: canonical.filter((share) => share.accessType === 'protected').length,
        public: canonical.filter((share) => share.accessType === 'public').length,
      },
    };
  }

  async findShare(shareId: string): Promise<StoredShare | undefined> {
    const stored = this.#shares.get(shareId);
    return stored === undefined ? undefined : copyShare(stored);
  }

  async findShareByPublicCode(publicCode: string): Promise<StoredShare | undefined> {
    const stored = [...this.#shares.values()].find(
      (share) => share.accessType === 'public' && share.publicCode === publicCode,
    );
    return stored === undefined ? undefined : copyShare(stored);
  }

  async findSharesByIds(request: {
    installationId: string;
    workspaceId: string;
    shareIds: readonly string[];
  }): Promise<StoredShare[]> {
    const ids = new Set(request.shareIds);
    return [...this.#shares.values()]
      .filter(
        (share) =>
          ids.has(share.shareId) &&
          share.installationId === request.installationId &&
          share.workspaceId === request.workspaceId,
      )
      .map(copyShare);
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

  async setCommentPolicy(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    commentPolicy: 'off' | 'private' | 'shared';
  }) {
    const stored = this.#shares.get(request.shareId);
    if (
      stored === undefined ||
      stored.installationId !== request.installationId ||
      stored.workspaceId !== request.workspaceId
    )
      return { status: 'not-found' as const };
    const updated = { ...stored, commentPolicy: request.commentPolicy };
    this.#shares.set(request.shareId, updated);
    for (const [key, record] of this.#idempotency) {
      if (record.result.shareId === updated.shareId) {
        this.#idempotency.set(key, { fingerprint: record.fingerprint, result: updated });
      }
    }
    return { status: 'updated' as const, result: copyShare(updated) };
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

  async resolvePublicShareTarget(publicCode: string): Promise<ResolvedStoredShare | undefined> {
    const share = [...this.#shares.values()].find(
      (candidate) => candidate.accessType === 'public' && candidate.publicCode === publicCode,
    );
    if (share === undefined) return undefined;
    const resolved = await this.resolveShareTarget(share.shareId);
    return resolved?.share.accessType === 'public' && resolved.share.publicCode === publicCode
      ? resolved
      : undefined;
  }

  async establishProtectedSession(request: {
    shareId: string;
    sessionId: string;
    now: string;
    receiptExpiresAt: string;
  }): Promise<EstablishProtectedSessionOutcome> {
    const now = Date.parse(request.now);
    const receiptExpiresAt = Date.parse(request.receiptExpiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(receiptExpiresAt) || receiptExpiresAt <= now) {
      throw new Error('Protected session establishment timestamps are invalid.');
    }

    let removed = 0;
    for (const [key, receipt] of this.#sessionReceipts) {
      if (
        removed < 100 &&
        receipt.share.shareId === request.shareId &&
        Date.parse(receipt.receiptExpiresAt) <= now
      ) {
        this.#sessionReceipts.delete(key);
        removed += 1;
      }
    }

    const share = this.#shares.get(request.shareId);
    const expiresAt = share?.expiresAt === null ? null : Date.parse(share?.expiresAt ?? '');
    if (
      share === undefined ||
      share.accessType !== 'protected' ||
      share.revokedAt !== null ||
      (expiresAt !== null && expiresAt <= now)
    ) {
      return { status: 'unavailable' };
    }

    const receiptKey = `${request.shareId}\u0000${request.sessionId}`;
    const existing = this.#sessionReceipts.get(receiptKey);
    if (existing !== undefined && Date.parse(existing.receiptExpiresAt) > now) {
      return {
        status: 'reused',
        result: { ...structuredClone(existing), share: copyShare(share) },
      };
    }
    if (share.maxSessions !== null && share.sessionsUsed >= share.maxSessions) {
      return { status: 'unavailable' };
    }

    const updated = { ...share, sessionsUsed: share.sessionsUsed + 1 };
    this.#shares.set(updated.shareId, updated);
    const establishment: ProtectedSessionEstablishment = {
      share: updated,
      sessionId: request.sessionId,
      establishedAt: request.now,
      receiptExpiresAt: request.receiptExpiresAt,
    };
    this.#sessionReceipts.set(receiptKey, establishment);
    return { status: 'established', result: structuredClone(establishment) };
  }
}
