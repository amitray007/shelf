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
  publicCode: 'AbCdEf0123_-',
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
};

export function rendererStoredShare(overrides: Partial<StoredShare> = {}): StoredShare {
  return {
    apiVersion: 'v1',
    installationId: 'install-main',
    workspaceId: 'workspace-main',
    shareId: rendererIds.share,
    artifactId: rendererIds.artifact,
    visibility: 'unlisted',
    accessType: 'protected',
    publicCode: null,
    target: { mode: 'latest' },
    createdByActorId: 'private-actor',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    maxSessions: null,
    sessionsUsed: 1,
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
    async resolvePublicShareTarget(publicCode) {
      if (share.accessType !== 'public' || share.publicCode !== publicCode) return undefined;
      return this.resolveShareTarget(share.shareId);
    },
    async establishProtectedSession() {
      return { status: 'unavailable' };
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
    async findFolderEntry() {
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

/** Dependencies for a Protected or Public share of one folder revision with the given files. */
export function rendererFolderDependencies(
  files: Record<string, { mediaType: string; content: Uint8Array }>,
  options: { share?: StoredShare } = {},
) {
  const dependencies = rendererDependencies(
    options.share === undefined ? {} : { share: options.share },
  );
  const share = options.share ?? rendererStoredShare();
  const createdAt = '2026-08-17T12:00:00.000Z';
  const byteCount = Object.values(files).reduce(
    (total, file) => total + file.content.byteLength,
    0,
  );
  const fileCount = Object.keys(files).length;
  const revision = {
    kind: 'folder' as const,
    revisionId: rendererIds.revision,
    revisionNumber: 1,
    rootName: 'site',
    contentHash: `sha256:${'b'.repeat(64)}`,
    byteCount,
    fileCount,
    createdAt,
    provenance: {
      classification: 'direct-publish' as const,
      observed: { actorId: 'private-actor', operation: 'folder.publish' as const },
    },
    publisherMetadata: {},
  };
  dependencies.shares.resolveShareTarget = async () => ({
    share,
    artifact: {
      installationId: 'install-main',
      workspaceId: 'workspace-main',
      artifactId: rendererIds.artifact,
      kind: 'folder',
      name: 'Site',
      createdAt,
      updatedAt: createdAt,
      retentionMode: 'automatic',
      autoTrashAt: null,
      latestRevision: revision,
    },
    revision: {
      installationId: 'install-main',
      workspaceId: 'workspace-main',
      artifactId: rendererIds.artifact,
      revision,
    },
  });
  dependencies.folders.findFolderRevision = async () => ({
    apiVersion: 'v1',
    kind: 'folder',
    installationId: 'install-main',
    workspaceId: 'workspace-main',
    artifactId: rendererIds.artifact,
    revisionId: rendererIds.revision,
    manifest: { contentId: 'folder-manifest', contentHash: revision.contentHash, byteCount: 1 },
    rootName: revision.rootName,
    totalByteCount: byteCount,
    fileCount,
    provenance: revision.provenance,
    publisherMetadata: {},
  });
  dependencies.folders.findFolderEntry = async (input) => {
    const file = files[input.path];
    if (
      file === undefined ||
      input.installationId !== 'install-main' ||
      input.revisionId !== rendererIds.revision
    ) {
      return undefined;
    }
    return {
      kind: 'file',
      path: input.path,
      mediaType: file.mediaType,
      content: {
        contentId: `content:${input.path}`,
        contentHash: `sha256:${'c'.repeat(64)}`,
        byteCount: file.content.byteLength,
      },
    };
  };
  dependencies.contentReader.read = async (content, readOptions) => {
    const path = content.contentId.replace(/^content:/u, '');
    const bytes = files[path]?.content ?? new Uint8Array();
    const range = readOptions?.range;
    const slice = range === undefined ? bytes : bytes.slice(range.start, range.end + 1);
    return (async function* folderContent() {
      yield slice;
    })();
  };
  return dependencies;
}
