import type {
  Artifact,
  ArtifactPage,
  ArtifactRevision,
  ArtifactRevisionPage,
  DashboardCredentialPage,
  DashboardSession,
  FolderTreePage,
  PublicShareResolution,
  SharePage,
} from '@shelf/contracts';

export const workspaceId = 'workspace-browser';
export const artifactId = `art_${'a'.repeat(22)}`;
export const folderArtifactId = `art_${'g'.repeat(22)}`;
export const shortArtifactId = `art_${'h'.repeat(22)}`;
export const jsonArtifactId = `art_${'i'.repeat(22)}`;
export const archiveArtifactId = `art_${'j'.repeat(22)}`;
export const revisionId = `rev_${'b'.repeat(22)}`;
export const folderRevisionId = `rev_${'g'.repeat(22)}`;
export const markdownShareId = `shr_${'c'.repeat(22)}`;
export const htmlShareId = `shr_${'d'.repeat(22)}`;
export const shareSecret = 's'.repeat(43);
export const createdShareId = `shr_${'r'.repeat(22)}`;
export const createdCredentialId = `crd_${'u'.repeat(22)}`;
export const createdCredentialToken = `shf_v1.${'u'.repeat(22)}.${'v'.repeat(43)}`;
export const rendererOrigin = 'http://localhost:43874';

export const longArtifactName =
  'quarterly-research-synthesis-with-model-evaluations-and-launch-readiness-notes.md';
export const longFolderName =
  'release-manifest-with-macos-windows-linux-bundles-and-reproducibility-metadata';
export const longFolderPath =
  'release-output/clients/macos-universal/application-assets/generated/documentation/reference/api/v1/manifest.json';

type FileRevision = Extract<ArtifactRevision, { kind: 'file' }>;
type FolderRevision = Extract<ArtifactRevision, { kind: 'folder' }>;

function fileRevision(input: {
  id: string;
  number: number;
  createdAt: string;
  name: string;
  mediaType?: string;
  bytes?: number;
  hashCharacter: string;
  restoredFrom?: string;
}): FileRevision {
  return {
    revisionId: input.id,
    revisionNumber: input.number,
    contentHash: `sha256:${input.hashCharacter.repeat(64)}`,
    createdAt: input.createdAt,
    provenance:
      input.restoredFrom === undefined
        ? {
            classification: 'direct-publish',
            observed: { actorId: 'actor-browser-owner', operation: 'file.publish' },
          }
        : {
            classification: 'restore',
            observed: { actorId: 'actor-browser-owner', operation: 'revision.restore' },
            source: { revisionId: input.restoredFrom },
          },
    publisherMetadata: { source: 'browser-density-qualification' },
    kind: 'file',
    originalFileName: input.name,
    mediaType: input.mediaType ?? 'text/markdown',
    byteCount: input.bytes ?? 89,
    fileCount: 1,
    paths: {
      revision: `/api/v1/revisions/${input.id}`,
      content: `/api/v1/revisions/${input.id}/content`,
    },
  };
}

function folderRevision(input: {
  id: string;
  number: number;
  createdAt: string;
  hashCharacter: string;
  bytes: number;
  files: number;
}): FolderRevision {
  return {
    revisionId: input.id,
    revisionNumber: input.number,
    contentHash: `sha256:${input.hashCharacter.repeat(64)}`,
    createdAt: input.createdAt,
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-browser-owner', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'browser-density-qualification' },
    kind: 'folder',
    rootName: longFolderName,
    byteCount: input.bytes,
    fileCount: input.files,
    paths: {
      revision: `/api/v1/revisions/${input.id}`,
      tree: `/api/v1/revisions/${input.id}/tree`,
    },
  };
}

const revision = fileRevision({
  id: revisionId,
  number: 12,
  createdAt: '2026-08-18T10:00:00.000Z',
  name: longArtifactName,
  hashCharacter: 'e',
});
const revision11 = fileRevision({
  id: `rev_${'k'.repeat(22)}`,
  number: 11,
  createdAt: '2026-08-17T16:30:00.000Z',
  name: 'research-synthesis.md',
  hashCharacter: 'a',
  restoredFrom: `rev_${'m'.repeat(22)}`,
});
const revision10 = fileRevision({
  id: `rev_${'l'.repeat(22)}`,
  number: 10,
  createdAt: '2026-08-16T08:15:00.000Z',
  name: 'notes.md',
  hashCharacter: 'b',
});
const revision9 = fileRevision({
  id: `rev_${'m'.repeat(22)}`,
  number: 9,
  createdAt: '2026-08-15T06:00:00.000Z',
  name: 'n.md',
  hashCharacter: 'c',
});

const latestFolderRevision = folderRevision({
  id: folderRevisionId,
  number: 8,
  createdAt: '2026-08-18T09:30:00.000Z',
  hashCharacter: 'd',
  bytes: 31_066,
  files: 3,
});
const previousFolderRevision = folderRevision({
  id: `rev_${'n'.repeat(22)}`,
  number: 7,
  createdAt: '2026-08-14T12:00:00.000Z',
  hashCharacter: 'f',
  bytes: 27_965,
  files: 2,
});
const shortRevision = fileRevision({
  id: `rev_${'h'.repeat(22)}`,
  number: 1,
  createdAt: '2026-08-18T08:00:00.000Z',
  name: 'x',
  hashCharacter: '0',
  bytes: 1,
});
const jsonRevision = fileRevision({
  id: `rev_${'i'.repeat(22)}`,
  number: 37,
  createdAt: '2026-08-17T11:00:00.000Z',
  name: 'model-evaluation-results-for-extended-reasoning-and-tool-use.json',
  mediaType: 'application/json',
  hashCharacter: '1',
  bytes: 1_887_436,
});
const archiveRevision = fileRevision({
  id: `rev_${'j'.repeat(22)}`,
  number: 3,
  createdAt: '2026-08-13T07:45:00.000Z',
  name: 'portfolio.zip',
  mediaType: 'application/zip',
  hashCharacter: '2',
  bytes: 25_794_560,
});

export const artifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId,
  kind: 'file',
  name: longArtifactName,
  createdAt: '2026-08-15T06:00:00.000Z',
  updatedAt: revision.createdAt,
  latestRevision: revision,
  paths: {
    artifact: `/api/v1/artifacts/${artifactId}`,
    revisions: `/api/v1/artifacts/${artifactId}/revisions`,
  },
} satisfies Artifact;

export const folderArtifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId: folderArtifactId,
  kind: 'folder',
  name: longFolderName,
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: latestFolderRevision.createdAt,
  latestRevision: latestFolderRevision,
  paths: {
    artifact: `/api/v1/artifacts/${folderArtifactId}`,
    revisions: `/api/v1/artifacts/${folderArtifactId}/revisions`,
  },
} satisfies Artifact;

const shortArtifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId: shortArtifactId,
  kind: 'file',
  name: 'x',
  createdAt: shortRevision.createdAt,
  updatedAt: shortRevision.createdAt,
  latestRevision: shortRevision,
  paths: {
    artifact: `/api/v1/artifacts/${shortArtifactId}`,
    revisions: `/api/v1/artifacts/${shortArtifactId}/revisions`,
  },
} satisfies Artifact;

const jsonArtifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId: jsonArtifactId,
  kind: 'file',
  name: jsonRevision.originalFileName,
  createdAt: '2026-08-10T11:00:00.000Z',
  updatedAt: jsonRevision.createdAt,
  latestRevision: jsonRevision,
  paths: {
    artifact: `/api/v1/artifacts/${jsonArtifactId}`,
    revisions: `/api/v1/artifacts/${jsonArtifactId}/revisions`,
  },
} satisfies Artifact;

const archiveArtifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId: archiveArtifactId,
  kind: 'file',
  name: archiveRevision.originalFileName,
  createdAt: archiveRevision.createdAt,
  updatedAt: archiveRevision.createdAt,
  latestRevision: archiveRevision,
  paths: {
    artifact: `/api/v1/artifacts/${archiveArtifactId}`,
    revisions: `/api/v1/artifacts/${archiveArtifactId}/revisions`,
  },
} satisfies Artifact;

const paginationRevisions = (
  [
    ['p', 'a'],
    ['q', 'b'],
    ['r', 'c'],
    ['s', 'd'],
    ['t', 'e'],
    ['u', 'f'],
    ['v', '3'],
  ] as const
).map(([character, hashCharacter], index) =>
  fileRevision({
    id: `rev_${character.toUpperCase().repeat(22)}`,
    number: 1,
    createdAt: `2026-08-${String(index + 1).padStart(2, '0')}T07:00:00.000Z`,
    name: `archive-${index + 1}.txt`,
    mediaType: 'text/plain',
    hashCharacter,
    bytes: 64 + index,
  }),
);

const paginationArtifacts = paginationRevisions.map(
  (paginationRevision, index) =>
    ({
      apiVersion: 'v1',
      workspaceId,
      artifactId: `art_${String.fromCharCode(112 + index).repeat(22)}`,
      kind: 'file',
      name: paginationRevision.originalFileName,
      createdAt: paginationRevision.createdAt,
      updatedAt: paginationRevision.createdAt,
      latestRevision: paginationRevision,
      paths: {
        artifact: `/api/v1/artifacts/art_${String.fromCharCode(112 + index).repeat(22)}`,
        revisions: `/api/v1/artifacts/art_${String.fromCharCode(112 + index).repeat(22)}/revisions`,
      },
    }) satisfies Artifact,
);

export const dashboardSession = {
  apiVersion: 'v1',
  actorId: 'actor-browser-owner',
  workspaces: [
    {
      workspaceId,
      actions: ['file.publish', 'revision.read'],
    },
  ],
} satisfies DashboardSession;

export const artifactPage = {
  apiVersion: 'v1',
  items: [
    artifact,
    folderArtifact,
    shortArtifact,
    jsonArtifact,
    archiveArtifact,
    ...paginationArtifacts,
  ],
  nextCursor: null,
} satisfies ArtifactPage;

export const historyPage = {
  apiVersion: 'v1',
  artifactId,
  workspaceId,
  items: [revision, revision11, revision10, revision9],
  nextCursor: null,
} satisfies ArtifactRevisionPage;

export const folderHistoryPage = {
  apiVersion: 'v1',
  artifactId: folderArtifactId,
  workspaceId,
  items: [latestFolderRevision, previousFolderRevision],
  nextCursor: null,
} satisfies ArtifactRevisionPage;

export const historyPages = [
  historyPage,
  folderHistoryPage,
  {
    apiVersion: 'v1',
    artifactId: shortArtifactId,
    workspaceId,
    items: [shortRevision],
    nextCursor: null,
  },
  {
    apiVersion: 'v1',
    artifactId: jsonArtifactId,
    workspaceId,
    items: [jsonRevision],
    nextCursor: null,
  },
  {
    apiVersion: 'v1',
    artifactId: archiveArtifactId,
    workspaceId,
    items: [archiveRevision],
    nextCursor: null,
  },
  ...paginationArtifacts.map((paginationArtifact, index) => {
    const paginationRevision = paginationRevisions[index];
    if (paginationRevision === undefined)
      throw new Error('Pagination revision fixture is missing.');
    return {
      apiVersion: 'v1' as const,
      artifactId: paginationArtifact.artifactId,
      workspaceId,
      items: [paginationRevision],
      nextCursor: null,
    };
  }),
] satisfies ArtifactRevisionPage[];

export const sharePage = {
  apiVersion: 'v1',
  workspaceId,
  items: [
    {
      apiVersion: 'v1',
      workspaceId,
      shareId: `shr_${'n'.repeat(22)}`,
      artifactId,
      visibility: 'unlisted',
      target: { mode: 'latest' },
      createdAt: '2026-08-18T10:05:00.000Z',
      expiresAt: null,
      revokedAt: null,
      url: `/s/shr_${'n'.repeat(22)}#${shareSecret}`,
    },
    {
      apiVersion: 'v1',
      workspaceId,
      shareId: `shr_${'o'.repeat(22)}`,
      artifactId,
      visibility: 'unlisted',
      target: { mode: 'pinned', revisionId: revision11.revisionId, revisionNumber: 11 },
      createdAt: '2026-08-17T17:00:00.000Z',
      expiresAt: null,
      revokedAt: '2026-08-18T07:30:00.000Z',
      url: `/s/shr_${'o'.repeat(22)}#${shareSecret}`,
    },
    {
      apiVersion: 'v1',
      workspaceId,
      shareId: `shr_${'p'.repeat(22)}`,
      artifactId,
      visibility: 'unlisted',
      target: { mode: 'pinned', revisionId: revision10.revisionId, revisionNumber: 10 },
      createdAt: '2026-08-16T09:00:00.000Z',
      expiresAt: '2026-08-17T09:00:00.000Z',
      revokedAt: null,
      url: `/s/shr_${'p'.repeat(22)}#${shareSecret}`,
    },
    {
      apiVersion: 'v1',
      workspaceId,
      shareId: `shr_${'q'.repeat(22)}`,
      artifactId: folderArtifactId,
      visibility: 'unlisted',
      target: { mode: 'latest' },
      createdAt: '2026-08-18T09:35:00.000Z',
      expiresAt: null,
      revokedAt: null,
      url: `/s/shr_${'q'.repeat(22)}#${shareSecret}`,
    },
  ],
  nextCursor: null,
} satisfies SharePage;

export const folderTreePage = {
  apiVersion: 'v1',
  revisionId: folderRevisionId,
  contentHash: latestFolderRevision.contentHash,
  byteCount: latestFolderRevision.byteCount,
  fileCount: latestFolderRevision.fileCount,
  items: [
    { path: 'release-output', kind: 'directory' },
    { path: 'release-output/clients', kind: 'directory' },
    { path: 'release-output/clients/macos-universal', kind: 'directory' },
    {
      path: longFolderPath,
      kind: 'file',
      mediaType: 'application/json',
      contentHash: `sha256:${'3'.repeat(64)}`,
      byteCount: 8_241,
    },
    {
      path: 'release-output/checksums.txt',
      kind: 'file',
      mediaType: 'text/plain',
      contentHash: `sha256:${'4'.repeat(64)}`,
      byteCount: 19_724,
    },
    {
      path: 'README.md',
      kind: 'file',
      mediaType: 'text/markdown',
      contentHash: `sha256:${'5'.repeat(64)}`,
      byteCount: 3_101,
    },
  ],
  nextCursor: null,
} satisfies FolderTreePage;

export const credentialPage = {
  apiVersion: 'v1',
  items: [
    {
      credentialId: `crd_${'f'.repeat(22)}`,
      actorId: 'actor-browser-agent',
      actorName: 'release-agent',
      createdAt: '2026-08-18T10:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      grants: [
        { workspaceId, action: 'file.publish' },
        { workspaceId, action: 'revision.read' },
      ],
    },
    {
      credentialId: `crd_${'x'.repeat(22)}`,
      actorId: 'actor-browser-expired-agent',
      actorName: 'expired-agent',
      createdAt: '2026-08-16T10:00:00.000Z',
      expiresAt: '2026-08-17T10:00:00.000Z',
      revokedAt: null,
      lastUsedAt: '2026-08-16T12:00:00.000Z',
      grants: [{ workspaceId, action: 'revision.read' }],
    },
  ],
  nextCursor: null,
} satisfies DashboardCredentialPage;

function publicFileResolution(
  shareId: string,
  mediaType: string,
  originalFileName: string,
): PublicShareResolution {
  return {
    apiVersion: 'v1',
    shareId,
    target: { mode: 'latest' },
    expiresAt: null,
    artifact: { artifactId, kind: 'file', name: originalFileName },
    revision: {
      revisionId,
      revisionNumber: revision.revisionNumber,
      createdAt: revision.createdAt,
      kind: 'file',
      originalFileName,
      mediaType,
      byteCount: 89,
    },
    action: {
      type: 'content',
      path: `/api/v1/public/shares/${shareId}/content`,
    },
  };
}

export const markdownResolution = publicFileResolution(markdownShareId, 'text/markdown', 'idea.md');

export const htmlResolution = publicFileResolution(htmlShareId, 'text/html', 'idea.html');
