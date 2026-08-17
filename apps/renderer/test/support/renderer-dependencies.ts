import type {
  ContentReader,
  FolderRevisionRepository,
  RevisionRepository,
  ShareRepository,
  StoredShare,
} from '@shelf/core';

export const rendererIds = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  share: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
};

export function rendererStoredShare(overrides: Partial<StoredShare> = {}): StoredShare {
  return {
    apiVersion: 'v1',
    installationId: 'install-main',
    workspaceId: 'workspace-main',
    shareId: rendererIds.share,
    artifactId: rendererIds.artifact,
    visibility: 'unlisted',
    target: { mode: 'latest' },
    createdByActorId: 'private-actor',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revokedByActorId: null,
    ...overrides,
  };
}

export function rendererDependencies(
  options: {
    share?: StoredShare;
    mediaType?: string;
    content?: Uint8Array;
    readContent?: Uint8Array;
  } = {},
) {
  const share = options.share ?? rendererStoredShare();
  const bytes = options.content ?? new TextEncoder().encode('<!doctype html><h1>Artifact</h1>');
  const descriptor = {
    kind: 'file' as const,
    revisionId: rendererIds.revision,
    revisionNumber: 1,
    originalFileName: 'artifact.html',
    mediaType: options.mediaType ?? 'text/html',
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteCount: bytes.byteLength,
    createdAt: '2026-08-17T12:00:00.000Z',
    provenance: {
      classification: 'direct-publish' as const,
      observed: { actorId: 'private-actor', operation: 'file.publish' as const },
    },
    publisherMetadata: { private: 'metadata' },
  };
  const shares: ShareRepository = {
    async findArtifactForShare() {
      return undefined;
    },
    async findRevisionForShare() {
      return undefined;
    },
    async findCreateIdempotency() {
      return undefined;
    },
    async commitCreate(input) {
      return { status: 'committed', result: input.result };
    },
    async listShares() {
      return { items: [] };
    },
    async findShare() {
      return share;
    },
    async revokeShare() {
      return { status: 'not-found' };
    },
    async resolveShareTarget() {
      return {
        share,
        artifact: {
          installationId: 'install-main',
          workspaceId: 'workspace-main',
          artifactId: rendererIds.artifact,
          kind: 'file',
          name: 'Artifact',
          createdAt: descriptor.createdAt,
          updatedAt: descriptor.createdAt,
          latestRevision: descriptor,
        },
        revision: {
          installationId: 'install-main',
          workspaceId: 'workspace-main',
          artifactId: rendererIds.artifact,
          revision: descriptor,
        },
      };
    },
  };
  const revisions: RevisionRepository = {
    async findIdempotency() {
      return undefined;
    },
    async commitPublish(input) {
      return { status: 'committed', result: input.result };
    },
    async findRevision() {
      return {
        apiVersion: 'v1',
        installationId: 'install-main',
        workspaceId: 'workspace-main',
        artifactId: rendererIds.artifact,
        revisionId: rendererIds.revision,
        content: {
          contentId: 'private-content-id',
          contentHash: descriptor.contentHash,
          byteCount: bytes.byteLength,
        },
        originalFileName: descriptor.originalFileName,
        mediaType: descriptor.mediaType,
        provenance: descriptor.provenance,
        publisherMetadata: descriptor.publisherMetadata,
      };
    },
  };
  const folders: FolderRevisionRepository = {
    async findFolderIdempotency() {
      return undefined;
    },
    async commitFolderPublish(input) {
      return { status: 'committed', result: input.result };
    },
    async findFolderRevision() {
      return undefined;
    },
    async listFolderEntries() {
      return { items: [] };
    },
  };
  const contentReader: ContentReader = {
    async read() {
      return (async function* content() {
        yield options.readContent ?? bytes;
      })();
    },
  };
  return { shares, revisions, folders, contentReader };
}
