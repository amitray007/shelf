import { createHash } from 'node:crypto';

import {
  FOLDER_LIMITS,
  type FolderManifestInput,
  type FolderPublishResult,
  PUBLISH_CONTRACT_VERSION,
  PUBLISH_OPERATION,
  type PublisherMetadata,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type {
  ArtifactIdentity,
  ArtifactIdentityRepository,
  Authorizer,
  ContentStore,
  IdempotencyNamespace,
  OpaqueIdGenerator,
  SealedContent,
  StagedContent,
} from '../publishing/ports.js';
import {
  ArtifactNotFoundError,
  createOpaqueId,
  IdempotencyConflictError,
  InvalidPublishRequestError,
  PublishCancelledError,
  validatePublisherMetadata,
} from '../publishing/publish.js';
import {
  canonicalFolderManifest,
  type StoredFolderEntry,
  validateFolderManifestInput,
} from './snapshot.js';

export interface StoredFolderPublish {
  apiVersion: 'v1';
  kind: 'folder';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  manifest: SealedContent;
  rootName: string;
  totalByteCount: number;
  fileCount: number;
  provenance: {
    classification: 'direct-publish';
    observed: { actorId: string; operation: typeof PUBLISH_OPERATION };
  };
  publisherMetadata: PublisherMetadata;
}

export interface StoredFolderRestore {
  apiVersion: 'v1';
  kind: 'folder';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  manifest: SealedContent;
  rootName: string;
  totalByteCount: number;
  fileCount: number;
  provenance: {
    classification: 'restore';
    observed: { actorId: string; operation: 'revision.restore' };
    source: { revisionId: string };
  };
  publisherMetadata: PublisherMetadata;
}

export type StoredFolderRevision = StoredFolderPublish | StoredFolderRestore;

export interface FolderIdempotencyRecord {
  fingerprint: string;
  result?: StoredFolderPublish;
}

export interface CommitFolderPublishInput {
  namespace: IdempotencyNamespace;
  fingerprint: string;
  result: StoredFolderPublish;
  entries: readonly StoredFolderEntry[];
}

export type CommitFolderPublishOutcome =
  | { status: 'committed' | 'replayed'; result: StoredFolderPublish }
  | { status: 'conflict' };

export interface FolderRevisionRepository {
  findFolderIdempotency(
    namespace: IdempotencyNamespace,
  ): Promise<FolderIdempotencyRecord | undefined>;
  commitFolderPublish(input: CommitFolderPublishInput): Promise<CommitFolderPublishOutcome>;
  findFolderRevision(revisionId: string): Promise<StoredFolderRevision | undefined>;
  listFolderEntries(request: {
    installationId: string;
    revisionId: string;
    limit: number;
    afterPath?: string;
  }): Promise<{ items: StoredFolderEntry[]; nextPath?: string }>;
}

export interface PublishFolderRequest {
  installationId: string;
  workspaceId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  artifactId?: string;
  publisherMetadata: PublisherMetadata;
  manifest: FolderManifestInput;
  files: Iterable<AsyncIterable<Uint8Array>> | AsyncIterable<AsyncIterable<Uint8Array>>;
  signal?: AbortSignal;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new PublishCancelledError(signal.reason);
}

async function discardBestEffort(store: ContentStore, staged: readonly StagedContent[]) {
  await Promise.all(
    staged.map(async (value) => {
      try {
        await store.discard(value);
      } catch {
        // Reconciliation owns residue when best-effort cleanup cannot complete.
      }
    }),
  );
}

function iteratorFor(
  files: PublishFolderRequest['files'],
): AsyncIterator<AsyncIterable<Uint8Array>> {
  if (Symbol.asyncIterator in files) return files[Symbol.asyncIterator]();
  const iterator = files[Symbol.iterator]();
  return {
    async next() {
      return iterator.next();
    },
  };
}

function validateIdentity(request: PublishFolderRequest): void {
  const details: Array<{ field: string; reason: string }> = [];
  for (const [field, value] of [
    ['installationId', request.installationId],
    ['workspaceId', request.workspaceId],
    ['actorId', request.actorId],
    ['requestId', request.requestId],
    ['idempotencyKey', request.idempotencyKey],
  ] as const) {
    if (value.length === 0 || value.length > 128) {
      details.push({ field, reason: 'must contain 1-128 characters' });
    }
  }
  if (request.artifactId !== undefined && !/^art_[A-Za-z0-9_-]{22}$/u.test(request.artifactId)) {
    details.push({ field: 'artifactId', reason: 'must be a valid opaque artifact ID' });
  }
  if (details.length > 0) throw new InvalidPublishRequestError(details);
}

export function createFolderPublishFingerprint(input: {
  artifactId?: string;
  rootName: string;
  manifestHash: string;
  publisherMetadata: PublisherMetadata;
}): string {
  const canonical = JSON.stringify({ version: 1, ...input });
  return `folder-publish-request/v1:sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function asResult(
  stored: StoredFolderPublish,
  requestId: string,
  replayed: boolean,
): FolderPublishResult {
  return {
    apiVersion: stored.apiVersion,
    kind: 'folder',
    workspaceId: stored.workspaceId,
    artifactId: stored.artifactId,
    revisionId: stored.revisionId,
    contentHash: stored.manifest.contentHash,
    byteCount: stored.totalByteCount,
    fileCount: stored.fileCount,
    provenance: {
      classification: 'direct-publish',
      observed: { ...stored.provenance.observed },
    },
    publisherMetadata: { ...stored.publisherMetadata },
    requestId,
    paths: {
      artifact: `/api/v1/artifacts/${stored.artifactId}`,
      revision: `/api/v1/revisions/${stored.revisionId}`,
      tree: `/api/v1/revisions/${stored.revisionId}/tree`,
    },
    replayed,
  };
}

export function createFolderPublishService(dependencies: {
  authorizer: Authorizer;
  artifactRepository: ArtifactIdentityRepository;
  contentStore: ContentStore;
  folderRepository: FolderRevisionRepository;
  generateId?: OpaqueIdGenerator;
}) {
  const generateId = dependencies.generateId ?? createOpaqueId;

  return async function publishFolder(request: PublishFolderRequest): Promise<FolderPublishResult> {
    validateIdentity(request);
    const publisherMetadata = validatePublisherMetadata(request.publisherMetadata);
    const manifest = validateFolderManifestInput(request.manifest);
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
      if (artifact.kind !== 'folder') {
        throw new InvalidPublishRequestError([
          { field: 'artifactId', reason: 'must identify a folder artifact' },
        ]);
      }
    }

    const staged: Array<{
      entry: Extract<(typeof manifest.entries)[number], { kind: 'file' }>;
      staged: StagedContent;
      contentHash: string;
      byteCount: number;
    }> = [];
    const fileIterator = iteratorFor(request.files);
    let totalByteCount = 0;

    try {
      for (const entry of manifest.entries) {
        if (entry.kind === 'directory') continue;
        const next = await fileIterator.next();
        if (next.done) {
          throw new InvalidPublishRequestError([
            { field: 'files', reason: 'one file part is required for every manifest file entry' },
          ]);
        }
        const hash = createHash('sha256');
        let byteCount = 0;
        const hashingContent = (async function* content() {
          for await (const chunk of next.value) {
            throwIfCancelled(request.signal);
            byteCount += chunk.byteLength;
            totalByteCount += chunk.byteLength;
            if (byteCount > FOLDER_LIMITS.maxFileBytes) {
              throw new InvalidPublishRequestError([
                { field: `files.${entry.path}`, reason: 'exceeds the per-file byte limit' },
              ]);
            }
            if (totalByteCount > FOLDER_LIMITS.maxTotalBytes) {
              throw new InvalidPublishRequestError([
                { field: 'files', reason: 'exceeds the aggregate folder byte limit' },
              ]);
            }
            hash.update(chunk);
            yield chunk;
          }
        })();
        const value = await dependencies.contentStore.stage(hashingContent, {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        staged.push({
          entry,
          staged: value,
          contentHash: `sha256:${hash.digest('hex')}`,
          byteCount,
        });
      }
      if (!(await fileIterator.next()).done) {
        throw new InvalidPublishRequestError([
          { field: 'files', reason: 'contains more file parts than the manifest' },
        ]);
      }
    } catch (error) {
      await discardBestEffort(
        dependencies.contentStore,
        staged.map((value) => value.staged),
      );
      if (error instanceof ShelfCoreError) throw error;
      if (request.signal?.aborted === true) throw new PublishCancelledError(error);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Folder content staging failed.', error);
    }

    const provisionalEntries: StoredFolderEntry[] = [];
    let fileIndex = 0;
    for (const entry of manifest.entries) {
      if (entry.kind === 'directory') {
        provisionalEntries.push(entry);
      } else {
        const value = staged[fileIndex++];
        if (value === undefined) throw new Error('Folder staging lost a manifest entry.');
        provisionalEntries.push({
          ...entry,
          content: {
            contentId: '',
            contentHash: value.contentHash,
            byteCount: value.byteCount,
          },
        });
      }
    }
    const canonical = canonicalFolderManifest(provisionalEntries);
    const fingerprint = createFolderPublishFingerprint({
      ...(request.artifactId === undefined ? {} : { artifactId: request.artifactId }),
      rootName: manifest.rootName,
      manifestHash: canonical.contentHash,
      publisherMetadata,
    });
    const namespace: IdempotencyNamespace = {
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      actorId: request.actorId,
      operation: PUBLISH_OPERATION,
      key: request.idempotencyKey,
    };
    try {
      const existing = await dependencies.folderRepository.findFolderIdempotency(namespace);
      if (existing !== undefined) {
        await discardBestEffort(
          dependencies.contentStore,
          staged.map((value) => value.staged),
        );
        if (existing.fingerprint !== fingerprint || existing.result === undefined) {
          throw new IdempotencyConflictError();
        }
        return asResult(existing.result, request.requestId, true);
      }
    } catch (error) {
      await discardBestEffort(
        dependencies.contentStore,
        staged.map((value) => value.staged),
      );
      if (error instanceof ShelfCoreError) throw error;
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Idempotency lookup failed.', error);
    }

    const sealedEntries: StoredFolderEntry[] = [];
    fileIndex = 0;
    try {
      for (const entry of manifest.entries) {
        if (entry.kind === 'directory') {
          sealedEntries.push(entry);
          continue;
        }
        const value = staged[fileIndex++];
        if (value === undefined) throw new Error('Folder sealing lost a manifest entry.');
        const content = await dependencies.contentStore.seal(value.staged, {
          contentHash: value.contentHash,
          byteCount: value.byteCount,
        });
        sealedEntries.push({ ...entry, content });
      }
    } catch (error) {
      await discardBestEffort(
        dependencies.contentStore,
        staged.slice(Math.max(0, fileIndex - 1)).map((value) => value.staged),
      );
      if (request.signal?.aborted === true) throw new PublishCancelledError(error);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Folder content sealing failed.', error);
    }

    throwIfCancelled(request.signal);
    const manifestContent = canonicalFolderManifest(sealedEntries);
    let manifestStage: StagedContent;
    try {
      manifestStage = await dependencies.contentStore.stage(
        (async function* bytes() {
          yield manifestContent.bytes;
        })(),
        request.signal === undefined ? {} : { signal: request.signal },
      );
    } catch (error) {
      if (request.signal?.aborted === true) throw new PublishCancelledError(error);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Folder manifest staging failed.', error);
    }
    let sealedManifest: SealedContent;
    try {
      sealedManifest = await dependencies.contentStore.seal(manifestStage, {
        contentHash: manifestContent.contentHash,
        byteCount: manifestContent.bytes.byteLength,
      });
    } catch (error) {
      await discardBestEffort(dependencies.contentStore, [manifestStage]);
      throw boundaryFailure('CONTENT_UNAVAILABLE', 'Folder manifest sealing failed.', error);
    }
    throwIfCancelled(request.signal);

    const result: StoredFolderPublish = Object.freeze({
      apiVersion: PUBLISH_CONTRACT_VERSION,
      kind: 'folder',
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      artifactId: request.artifactId ?? generateId('art'),
      revisionId: generateId('rev'),
      manifest: Object.freeze({ ...sealedManifest }),
      rootName: manifest.rootName,
      totalByteCount: manifestContent.byteCount,
      fileCount: manifestContent.fileCount,
      provenance: Object.freeze({
        classification: 'direct-publish',
        observed: Object.freeze({ actorId: request.actorId, operation: PUBLISH_OPERATION }),
      }),
      publisherMetadata: Object.freeze({ ...publisherMetadata }),
    });

    let outcome: CommitFolderPublishOutcome;
    try {
      outcome = await dependencies.folderRepository.commitFolderPublish({
        namespace,
        fingerprint,
        result,
        entries: sealedEntries,
      });
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Folder revision commit failed.', error);
    }
    throwIfCancelled(request.signal);
    if (outcome.status === 'conflict') throw new IdempotencyConflictError();
    return asResult(outcome.result, request.requestId, outcome.status === 'replayed');
  };
}
