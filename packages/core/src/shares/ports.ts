import type { ShareTarget } from '@shelf/contracts';

import type { StoredArtifact, StoredArtifactRevision } from '../artifacts/catalog.js';

export interface StoredShare {
  apiVersion: 'v1';
  installationId: string;
  workspaceId: string;
  shareId: string;
  artifactId: string;
  visibility: 'unlisted';
  target: ShareTarget;
  createdByActorId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByActorId: string | null;
}

export interface StoredShareRevision {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revision: StoredArtifactRevision;
}

export interface ShareCreateIdempotencyNamespace {
  installationId: string;
  workspaceId: string;
  actorId: string;
  operation: 'share.create';
  key: string;
}

export interface ShareCreateIdempotencyRecord {
  fingerprint: string;
  result: StoredShare;
}

export interface CommitShareCreateInput {
  namespace: ShareCreateIdempotencyNamespace;
  fingerprint: string;
  result: StoredShare;
}

export type CommitShareCreateOutcome =
  | { status: 'committed' | 'replayed'; result: StoredShare }
  | { status: 'conflict' };

export interface ResolvedStoredShare {
  share: StoredShare;
  artifact: StoredArtifact;
  revision: StoredShareRevision;
}

export type RevokeShareOutcome =
  | { status: 'revoked' | 'already-revoked'; result: StoredShare }
  | { status: 'not-found' };

export interface ShareRepository {
  findArtifactForShare(artifactId: string): Promise<StoredArtifact | undefined>;
  findRevisionForShare(revisionId: string): Promise<StoredShareRevision | undefined>;
  findCreateIdempotency(
    namespace: ShareCreateIdempotencyNamespace,
  ): Promise<ShareCreateIdempotencyRecord | undefined>;
  /** Linearize share creation and the successful idempotency record in one atomic operation. */
  commitCreate(input: CommitShareCreateInput): Promise<CommitShareCreateOutcome>;
  listShares(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { createdAt: string; shareId: string };
  }): Promise<{ items: StoredShare[]; next?: { createdAt: string; shareId: string } }>;
  findShare(shareId: string): Promise<StoredShare | undefined>;
  /** Linearize concurrent revocations and return the canonical persisted result. */
  revokeShare(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    revokedByActorId: string;
    revokedAt: string;
  }): Promise<RevokeShareOutcome>;
  /** Resolve latest or pinned revision selection atomically with the share lookup. */
  resolveShareTarget(shareId: string): Promise<ResolvedStoredShare | undefined>;
}

export interface ShareCapabilityCodec {
  /** Deterministically derive the capability so an idempotent replay can reproduce its URL. */
  deriveSecret(shareId: string): string;
  /** Validate capability material without requiring raw-secret persistence. */
  validateSecret(shareId: string, secret: string): boolean;
}

export type ShareClock = () => Date;
export type ShareIdGenerator = () => string;
