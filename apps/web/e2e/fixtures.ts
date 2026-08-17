import type {
  Artifact,
  ArtifactPage,
  ArtifactRevisionPage,
  DashboardCredentialPage,
  DashboardSession,
  PublicShareResolution,
  SharePage,
} from '@shelf/contracts';

export const workspaceId = 'workspace-browser';
export const artifactId = `art_${'a'.repeat(22)}`;
export const revisionId = `rev_${'b'.repeat(22)}`;
export const markdownShareId = `shr_${'c'.repeat(22)}`;
export const htmlShareId = `shr_${'d'.repeat(22)}`;
export const shareSecret = 's'.repeat(43);
export const rendererOrigin = 'http://localhost:43874';

const revision = {
  revisionId,
  revisionNumber: 3,
  contentHash: `sha256:${'e'.repeat(64)}`,
  createdAt: '2026-08-18T10:00:00.000Z',
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-browser-owner', operation: 'file.publish' },
  },
  publisherMetadata: { source: 'browser-qualification' },
  kind: 'file',
  originalFileName: 'idea.md',
  mediaType: 'text/markdown',
  byteCount: 89,
  fileCount: 1,
  paths: {
    revision: `/api/v1/revisions/${revisionId}`,
    content: `/api/v1/revisions/${revisionId}/content`,
  },
} as const;

export const artifact = {
  apiVersion: 'v1',
  workspaceId,
  artifactId,
  kind: 'file',
  name: 'idea.md',
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: revision.createdAt,
  latestRevision: revision,
  paths: {
    artifact: `/api/v1/artifacts/${artifactId}`,
    revisions: `/api/v1/artifacts/${artifactId}/revisions`,
  },
} satisfies Artifact;

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
  items: [artifact],
  nextCursor: null,
} satisfies ArtifactPage;

export const historyPage = {
  apiVersion: 'v1',
  artifactId,
  workspaceId,
  items: [revision],
  nextCursor: null,
} satisfies ArtifactRevisionPage;

export const sharePage = {
  apiVersion: 'v1',
  workspaceId,
  items: [],
  nextCursor: null,
} satisfies SharePage;

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
      revisionNumber: 3,
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
