import type { ShareTarget } from '@shelf/contracts';

import type { StoredArtifact, StoredArtifactRevision } from '../artifacts/catalog.js';

export interface StoredShare {
  apiVersion: 'v1';
  installationId: string;
  workspaceId: string;
  shareId: string;
  artifactId: string;
  visibility: 'unlisted';
  accessType: 'protected' | 'public';
  publicCode: string | null;
  target: ShareTarget;
  createdByActorId: string;
  createdAt: string;
  expiresAt: string | null;
  maxSessions: number | null;
  sessionsUsed: number;
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
  purpose: 'user-created' | 'artifact-default';
}

export type CommitShareCreateOutcome =
  | { status: 'committed' | 'replayed'; result: StoredShare }
  | { status: 'conflict' }
  | { status: 'default-conflict' }
  | { status: 'public-code-conflict' };

export interface ProtectedSessionEstablishment {
  share: StoredShare;
  sessionId: string;
  establishedAt: string;
  receiptExpiresAt: string;
}

export type EstablishProtectedSessionOutcome =
  | {
      status: 'established' | 'reused';
      result: ProtectedSessionEstablishment;
    }
  | { status: 'unavailable' };

export interface ResolvedStoredShare {
  share: StoredShare;
  artifact: StoredArtifact;
  revision: StoredShareRevision;
}

export interface ArtifactDefaultShareState {
  protected?: StoredShare;
  public?: StoredShare;
  generations: { protected: number; public: number };
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
  /** Return the active permanent Latest defaults and bounded generation counts for one artifact. */
  findArtifactDefaultShares(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
  }): Promise<ArtifactDefaultShareState>;
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
  /** Resolve a secret-free Public selector without exposing Protected rows. */
  resolvePublicShareTarget(publicCode: string): Promise<ResolvedStoredShare | undefined>;
  /**
   * Linearize a Protected establishment receipt and the lifetime usage increment on the share.
   * Reusing the same live receipt does not increment usage; a different ID at the limit is unavailable.
   */
  establishProtectedSession(request: {
    shareId: string;
    sessionId: string;
    now: string;
    receiptExpiresAt: string;
  }): Promise<EstablishProtectedSessionOutcome>;
}

export interface ShareCapabilityCodec {
  /** Deterministically derive the capability so an idempotent replay can reproduce its URL. */
  deriveSecret(shareId: string): string;
  /** Validate capability material without requiring raw-secret persistence. */
  validateSecret(shareId: string, secret: string): boolean;
}

export type ShareClock = () => Date;
export type ShareIdGenerator = () => string;
export type PublicShareCodeGenerator = () => string;
