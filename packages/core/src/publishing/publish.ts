import { createHash, randomBytes } from 'node:crypto';

import {
  type ErrorDetail,
  PUBLISH_CONTRACT_VERSION,
  PUBLISH_OPERATION,
  PUBLISHER_METADATA_LIMITS,
  type PublisherMetadata,
  type PublishResult,
  RESERVED_PROVENANCE_KEYS,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';

import type {
  ArtifactIdentity,
  ArtifactIdentityRepository,
  Authorizer,
  CommitPublishOutcome,
  ContentStore,
  IdempotencyNamespace,
  OpaqueIdGenerator,
  OpaqueIdKind,
  RevisionRepository,
  SealedContent,
  StagedContent,
  StoredPublish,
} from './ports.js';

const MAX_IDENTITY_LENGTH = 128;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 255;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const OPAQUE_ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/u;
const RESERVED_PROVENANCE_KEY_SET = new Set<string>(RESERVED_PROVENANCE_KEYS);

export interface PublishFileRequest {
  installationId: string;
  workspaceId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  artifactId?: string;
  originalFileName: string;
  mediaType: string;
  publisherMetadata: PublisherMetadata;
  content: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface PublishServiceDependencies {
  authorizer: Authorizer;
  artifactRepository: ArtifactIdentityRepository;
  contentStore: ContentStore;
  revisionRepository: RevisionRepository;
  generateId?: OpaqueIdGenerator;
}

export class InvalidPublishRequestError extends ShelfCoreError {
  constructor(details: ErrorDetail[]) {
    super('INVALID_REQUEST', 'The publish request is invalid.', {
      retryable: false,
      details,
    });
    this.name = 'InvalidPublishRequestError';
  }
}

export class AuthorizationDeniedError extends ShelfCoreError {
  constructor() {
    super('AUTHORIZATION_DENIED', 'The actor cannot access this workspace.', {
      retryable: false,
    });
    this.name = 'AuthorizationDeniedError';
  }
}

export class IdempotencyConflictError extends ShelfCoreError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used for a different request.', {
      retryable: false,
      details: [{ field: 'idempotencyKey', reason: 'conflict' }],
    });
    this.name = 'IdempotencyConflictError';
  }
}

export class ArtifactNotFoundError extends ShelfCoreError {
  constructor() {
    super('ARTIFACT_NOT_FOUND', 'The requested artifact was not found.', { retryable: false });
    this.name = 'ArtifactNotFoundError';
  }
}

export class PublishCancelledError extends ShelfCoreError {
  constructor(cause?: unknown) {
    super('REQUEST_CANCELLED', 'The publish request was cancelled.', {
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'PublishCancelledError';
  }
}

export function createOpaqueId(kind: OpaqueIdKind): string {
  return `${kind}_${randomBytes(16).toString('base64url')}`;
}

export function canonicalizePublisherMetadata(metadata: PublisherMetadata): PublisherMetadata {
  return Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

export function createPublishFingerprint(input: {
  artifactId?: string;
  contentHash: string;
  originalFileName: string;
  mediaType: string;
  publisherMetadata: PublisherMetadata;
}): string {
  const canonicalRequest = JSON.stringify({
    version: 1,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    contentHash: input.contentHash,
    originalFileName: input.originalFileName,
    mediaType: input.mediaType,
    publisherMetadata: canonicalizePublisherMetadata(input.publisherMetadata),
  });
  return `publish-request/v1:sha256:${createHash('sha256').update(canonicalRequest).digest('hex')}`;
}

function validateIdentity(field: string, value: string, details: ErrorDetail[]): void {
  if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    details.push({ field, reason: `must contain 1-${MAX_IDENTITY_LENGTH} characters` });
  }
}

export function validatePublisherMetadata(metadata: PublisherMetadata): PublisherMetadata {
  const details: ErrorDetail[] = [];
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    details.push({ field: 'publisherMetadata', reason: 'must be an object of string values' });
  } else {
    const entries = Object.entries(metadata);
    if (entries.length > PUBLISHER_METADATA_LIMITS.maxKeys) {
      details.push({
        field: 'publisherMetadata',
        reason: `must contain at most ${PUBLISHER_METADATA_LIMITS.maxKeys} keys`,
      });
    }
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > PUBLISHER_METADATA_LIMITS.maxKeyLength) {
        details.push({ field: `publisherMetadata.${key}`, reason: 'metadata key is too long' });
      }
      if (RESERVED_PROVENANCE_KEY_SET.has(key)) {
        details.push({
          field: `publisherMetadata.${key}`,
          reason: 'server-observed provenance fields are reserved',
        });
      }
      if (typeof value !== 'string') {
        details.push({
          field: `publisherMetadata.${key}`,
          reason: 'metadata value must be a string',
        });
      } else if (value.length > PUBLISHER_METADATA_LIMITS.maxValueLength) {
        details.push({ field: `publisherMetadata.${key}`, reason: 'metadata value is too long' });
      }
    }
  }

  if (details.length > 0) throw new InvalidPublishRequestError(details);
  return canonicalizePublisherMetadata(metadata);
}

function validateRequest(request: PublishFileRequest): PublisherMetadata {
  const details: ErrorDetail[] = [];
  validateIdentity('installationId', request.installationId, details);
  validateIdentity('workspaceId', request.workspaceId, details);
  validateIdentity('actorId', request.actorId, details);
  validateIdentity('requestId', request.requestId, details);
  validateIdentity('idempotencyKey', request.idempotencyKey, details);
  if (request.artifactId !== undefined && !OPAQUE_ARTIFACT_ID_PATTERN.test(request.artifactId)) {
    details.push({ field: 'artifactId', reason: 'must be a valid opaque artifact ID' });
  }

  if (
    request.originalFileName.length === 0 ||
    request.originalFileName.length > MAX_FILE_NAME_LENGTH
  ) {
    details.push({
      field: 'originalFileName',
      reason: `must contain 1-${MAX_FILE_NAME_LENGTH} characters`,
    });
  }
  if (
    request.mediaType.length > MAX_MEDIA_TYPE_LENGTH ||
    !MEDIA_TYPE_PATTERN.test(request.mediaType)
  ) {
    details.push({ field: 'mediaType', reason: 'must be a valid type/subtype media type' });
  }
  if (details.length > 0) throw new InvalidPublishRequestError(details);
  return validatePublisherMetadata(request.publisherMetadata);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new PublishCancelledError(signal.reason);
}

async function discardBestEffort(contentStore: ContentStore, staged: StagedContent): Promise<void> {
  try {
    await contentStore.discard(staged);
  } catch {
    // Cleanup remains adapter/reconciliation work; never obscure the primary request failure.
  }
}

function idempotencyNamespace(request: PublishFileRequest): IdempotencyNamespace {
  return {
    installationId: request.installationId,
    workspaceId: request.workspaceId,
    actorId: request.actorId,
    operation: PUBLISH_OPERATION,
    key: request.idempotencyKey,
  };
}

function asResult(stored: StoredPublish, requestId: string, replayed: boolean): PublishResult {
  return {
    apiVersion: stored.apiVersion,
    kind: 'file',
    workspaceId: stored.workspaceId,
    artifactId: stored.artifactId,
    revisionId: stored.revisionId,
    contentHash: stored.content.contentHash,
    byteCount: stored.content.byteCount,
    fileCount: 1,
    provenance: {
      classification: stored.provenance.classification,
      observed: { ...stored.provenance.observed },
    },
    publisherMetadata: { ...stored.publisherMetadata },
    requestId,
    paths: {
      artifact: `/api/v1/artifacts/${stored.artifactId}`,
      revision: `/api/v1/revisions/${stored.revisionId}`,
      content: `/api/v1/revisions/${stored.revisionId}/content`,
    },
    replayed,
  };
}

export function createPublishService(dependencies: PublishServiceDependencies) {
  const generateId = dependencies.generateId ?? createOpaqueId;

  return async function publish(request: PublishFileRequest): Promise<PublishResult> {
    const publisherMetadata = validateRequest(request);
    throwIfCancelled(request.signal);
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        actorId: request.actorId,
        action: PUBLISH_OPERATION,
      },
      request.signal,
    );
    throwIfCancelled(request.signal);

    if (request.artifactId !== undefined) {
      let artifact: ArtifactIdentity | undefined;
      try {
        artifact = await dependencies.artifactRepository.findArtifactIdentity(request.artifactId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
      }
      if (
        artifact === undefined ||
        artifact.installationId !== request.installationId ||
        artifact.workspaceId !== request.workspaceId
      ) {
        throw new ArtifactNotFoundError();
      }
      throwIfCancelled(request.signal);
    }

    const hash = createHash('sha256');
    let byteCount = 0;
    const hashingContent = (async function* hashContent() {
      for await (const chunk of request.content) {
        throwIfCancelled(request.signal);
        byteCount += chunk.byteLength;
        if (!Number.isSafeInteger(byteCount)) {
          throw new InvalidPublishRequestError([
            { field: 'content', reason: 'content byte count exceeds the supported integer range' },
          ]);
        }
        hash.update(chunk);
        yield chunk;
      }
    })();

    let staged: StagedContent;
    try {
      staged = await dependencies.contentStore.stage(hashingContent, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted === true) throw new PublishCancelledError(error);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Content staging failed.', error);
    }

    const contentHash = `sha256:${hash.digest('hex')}`;
    if (byteCount === 0) {
      await discardBestEffort(dependencies.contentStore, staged);
      throw new InvalidPublishRequestError([{ field: 'content', reason: 'must not be empty' }]);
    }
    const fingerprint = createPublishFingerprint({
      ...(request.artifactId === undefined ? {} : { artifactId: request.artifactId }),
      contentHash,
      originalFileName: request.originalFileName,
      mediaType: request.mediaType,
      publisherMetadata,
    });
    const namespace = idempotencyNamespace(request);

    try {
      throwIfCancelled(request.signal);
      const existing = await dependencies.revisionRepository.findIdempotency(namespace);
      if (existing !== undefined) {
        await discardBestEffort(dependencies.contentStore, staged);
        if (existing.fingerprint !== fingerprint || existing.result === undefined) {
          throw new IdempotencyConflictError();
        }
        return asResult(existing.result, request.requestId, true);
      }
      throwIfCancelled(request.signal);
    } catch (error) {
      await discardBestEffort(dependencies.contentStore, staged);
      if (error instanceof ShelfCoreError) throw error;
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Idempotency lookup failed.', error);
    }

    let sealed: SealedContent;
    try {
      sealed = await dependencies.contentStore.seal(staged, { contentHash, byteCount });
    } catch (error) {
      await discardBestEffort(dependencies.contentStore, staged);
      if (request.signal?.aborted === true) throw new PublishCancelledError(error);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Content sealing failed.', error);
    }

    // Cancellation after sealing is authoritative and intentionally leaves an unreachable orphan.
    throwIfCancelled(request.signal);

    const artifactId = request.artifactId ?? generateId('art');
    const revisionId = generateId('rev');
    const stored: StoredPublish = Object.freeze({
      apiVersion: PUBLISH_CONTRACT_VERSION,
      kind: 'file',
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      artifactId,
      revisionId,
      content: Object.freeze({ ...sealed }),
      originalFileName: request.originalFileName,
      mediaType: request.mediaType,
      provenance: Object.freeze({
        classification: 'direct-publish',
        observed: Object.freeze({ actorId: request.actorId, operation: PUBLISH_OPERATION }),
      }),
      publisherMetadata: Object.freeze({ ...publisherMetadata }),
    });

    let outcome: CommitPublishOutcome;
    try {
      // No cancellation signal crosses this boundary: commit is the visibility linearization point.
      outcome = await dependencies.revisionRepository.commitPublish({
        namespace,
        fingerprint,
        result: stored,
      });
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision commit failed.', error);
    }

    // A disconnect may suppress this response, but the committed result remains replayable.
    throwIfCancelled(request.signal);
    if (outcome.status === 'conflict') throw new IdempotencyConflictError();
    return asResult(outcome.result, request.requestId, outcome.status === 'replayed');
  };
}
