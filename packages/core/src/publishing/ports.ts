import type {
  PUBLISH_OPERATION,
  PublisherMetadata,
  READ_REVISION_OPERATION,
  RESTORE_OPERATION,
} from '@shelf/contracts';

export interface AuthorizationRequest {
  installationId: string;
  workspaceId: string;
  actorId: string;
  action: typeof PUBLISH_OPERATION | typeof READ_REVISION_OPERATION;
}

export interface Authorizer {
  authorize(request: AuthorizationRequest, signal?: AbortSignal): Promise<void>;
}

export interface StagedContent {
  stageId: string;
}

export interface SealedContent {
  contentId: string;
  contentHash: string;
  byteCount: number;
}

export interface ContentStore {
  /**
   * Consume the entire stream before resolving. If consumption rejects, the adapter owns cleanup
   * of any partial stage because no stage handle is returned to the application service.
   */
  stage(
    content: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal },
  ): Promise<StagedContent>;
  discard(staged: StagedContent): Promise<void>;
  /** Seal staged bytes immutably. A successful seal may be retained as an unreachable orphan. */
  seal(
    staged: StagedContent,
    descriptor: { contentHash: string; byteCount: number },
  ): Promise<SealedContent>;
}

export interface ContentByteRange {
  /** Inclusive, zero-based byte offset. */
  start: number;
  /** Inclusive, zero-based byte offset. */
  end: number;
}

export interface ContentReader {
  /**
   * Open immutable content for streaming. Implementations must return exactly the selected bytes
   * and must not use publisher-supplied names to resolve a storage path.
   */
  read(
    content: SealedContent,
    options: { range?: ContentByteRange; signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>>;
}

export interface IdempotencyNamespace {
  installationId: string;
  workspaceId: string;
  actorId: string;
  operation: typeof PUBLISH_OPERATION;
  key: string;
}

export interface StoredPublish {
  apiVersion: 'v1';
  kind?: 'file';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  content: SealedContent;
  originalFileName: string;
  mediaType: string;
  provenance: {
    classification: 'direct-publish';
    observed: {
      actorId: string;
      operation: typeof PUBLISH_OPERATION;
    };
  };
  publisherMetadata: PublisherMetadata;
}

export interface StoredRestore {
  apiVersion: 'v1';
  kind?: 'file';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  content: SealedContent;
  originalFileName: string;
  mediaType: string;
  provenance: {
    classification: 'restore';
    observed: {
      actorId: string;
      operation: typeof RESTORE_OPERATION;
    };
    source: { revisionId: string };
  };
  publisherMetadata: PublisherMetadata;
}

export type StoredRevision = StoredPublish | StoredRestore;

export interface IdempotencyRecord {
  fingerprint: string;
  result?: StoredPublish;
}

export interface CommitPublishInput {
  namespace: IdempotencyNamespace;
  fingerprint: string;
  result: StoredPublish;
}

export interface ArtifactIdentity {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  kind?: 'file' | 'folder';
}

export interface ArtifactIdentityRepository {
  findArtifactIdentity(artifactId: string): Promise<ArtifactIdentity | undefined>;
}

export type CommitPublishOutcome =
  | { status: 'committed'; result: StoredPublish }
  | { status: 'replayed'; result: StoredPublish }
  | { status: 'conflict' };

export interface RevisionRepository {
  findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined>;
  /**
   * Linearize the idempotency check, artifact/revision creation, latest pointer, and successful
   * idempotency record in one atomic operation. This method deliberately has no cancellation
   * signal: once invoked, its visibility decision must finish.
   */
  commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome>;
  findRevision(revisionId: string): Promise<StoredRevision | undefined>;
}

export type OpaqueIdKind = 'art' | 'rev';
export type OpaqueIdGenerator = (kind: OpaqueIdKind) => string;
