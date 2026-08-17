import {
  type Artifact,
  type ArtifactPage,
  type ArtifactRevision,
  type ArtifactRevisionPage,
  type PublisherMetadata,
  READ_REVISION_OPERATION,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { Authorizer } from '../publishing/ports.js';
import { ArtifactNotFoundError } from '../publishing/publish.js';

const OPAQUE_ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/u;
const OPAQUE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

interface StoredArtifactRevisionCommon {
  revisionId: string;
  revisionNumber: number;
  contentHash: string;
  byteCount: number;
  fileCount?: number;
  createdAt: string;
  provenance: ArtifactRevision['provenance'];
  publisherMetadata: PublisherMetadata;
}

export interface StoredFileArtifactRevision extends StoredArtifactRevisionCommon {
  kind?: 'file';
  originalFileName: string;
  mediaType: string;
}

export interface StoredFolderArtifactRevision extends StoredArtifactRevisionCommon {
  kind: 'folder';
  rootName: string;
  fileCount: number;
}

export type StoredArtifactRevision = StoredFileArtifactRevision | StoredFolderArtifactRevision;

export interface StoredArtifact {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  kind?: 'file' | 'folder';
  name: string;
  createdAt: string;
  updatedAt: string;
  latestRevision: StoredArtifactRevision;
}

export interface ArtifactCatalogRepository {
  findArtifact(artifactId: string): Promise<StoredArtifact | undefined>;
  listArtifacts(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { updatedAt: string; artifactId: string };
  }): Promise<{ items: StoredArtifact[]; next?: { updatedAt: string; artifactId: string } }>;
  listArtifactRevisions(request: {
    installationId: string;
    artifactId: string;
    limit: number;
    beforeRevisionNumber?: number;
  }): Promise<{ items: StoredArtifactRevision[]; nextRevisionNumber?: number }>;
}

export class InvalidArtifactCatalogRequestError extends ShelfCoreError {
  constructor(field: 'cursor' | 'limit') {
    super('INVALID_REQUEST', 'The artifact catalog request is invalid.', {
      retryable: false,
      details: [{ field, reason: `must be a valid ${field}` }],
    });
    this.name = 'InvalidArtifactCatalogRequestError';
  }
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
}

function decodeCursor(value: string, kind: 'artifacts' | 'revisions'): Record<string, unknown> {
  try {
    if (!OPAQUE_CURSOR_PATTERN.test(value)) throw new Error('invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).v !== 1 ||
      (parsed as Record<string, unknown>).kind !== kind
    ) {
      throw new Error('invalid cursor');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InvalidArtifactCatalogRequestError('cursor');
  }
}

function limit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new InvalidArtifactCatalogRequestError('limit');
  }
  return value;
}

function artifactCursor(value: string | undefined) {
  if (value === undefined) return undefined;
  const cursor = decodeCursor(value, 'artifacts');
  const timestamp = typeof cursor.updatedAt === 'string' ? Date.parse(cursor.updatedAt) : NaN;
  if (
    typeof cursor.updatedAt !== 'string' ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== cursor.updatedAt ||
    typeof cursor.artifactId !== 'string' ||
    !OPAQUE_ARTIFACT_ID_PATTERN.test(cursor.artifactId)
  ) {
    throw new InvalidArtifactCatalogRequestError('cursor');
  }
  return { updatedAt: cursor.updatedAt, artifactId: cursor.artifactId };
}

function revisionCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const cursor = decodeCursor(value, 'revisions');
  if (!Number.isSafeInteger(cursor.revisionNumber) || (cursor.revisionNumber as number) < 1) {
    throw new InvalidArtifactCatalogRequestError('cursor');
  }
  return cursor.revisionNumber as number;
}

export function storedRevisionToArtifactRevision(stored: StoredArtifactRevision): ArtifactRevision {
  const provenance =
    stored.provenance.classification === 'restore'
      ? {
          classification: 'restore' as const,
          observed: { ...stored.provenance.observed },
          source: { ...stored.provenance.source },
        }
      : {
          classification: 'direct-publish' as const,
          observed: { ...stored.provenance.observed },
        };
  if (stored.kind === 'folder') {
    return {
      ...stored,
      kind: 'folder',
      provenance,
      publisherMetadata: { ...stored.publisherMetadata },
      paths: {
        revision: `/api/v1/revisions/${stored.revisionId}`,
        tree: `/api/v1/revisions/${stored.revisionId}/tree`,
      },
    };
  }
  return {
    ...stored,
    kind: 'file',
    fileCount: 1,
    provenance,
    publisherMetadata: { ...stored.publisherMetadata },
    paths: {
      revision: `/api/v1/revisions/${stored.revisionId}`,
      content: `/api/v1/revisions/${stored.revisionId}/content`,
    },
  };
}

export function storedArtifactToArtifact(stored: StoredArtifact): Artifact {
  return {
    apiVersion: 'v1',
    workspaceId: stored.workspaceId,
    artifactId: stored.artifactId,
    kind: stored.kind ?? stored.latestRevision.kind ?? 'file',
    name: stored.name,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    latestRevision: storedRevisionToArtifactRevision(stored.latestRevision),
    paths: {
      artifact: `/api/v1/artifacts/${stored.artifactId}`,
      revisions: `/api/v1/artifacts/${stored.artifactId}/revisions`,
    },
  };
}

export function createArtifactCatalogService(dependencies: {
  authorizer: Authorizer;
  artifacts: ArtifactCatalogRepository;
}) {
  async function authorizedArtifact(request: {
    installationId: string;
    actorId: string;
    artifactId: string;
    signal?: AbortSignal;
  }): Promise<StoredArtifact> {
    let stored: StoredArtifact | undefined;
    try {
      request.signal?.throwIfAborted();
      stored = await dependencies.artifacts.findArtifact(request.artifactId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact lookup failed.', error);
    }
    if (
      stored === undefined ||
      stored.artifactId !== request.artifactId ||
      stored.installationId !== request.installationId
    ) {
      throw new ArtifactNotFoundError();
    }
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: stored.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    request.signal?.throwIfAborted();
    return stored;
  }

  return {
    async getArtifact(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      signal?: AbortSignal;
    }): Promise<Artifact> {
      return storedArtifactToArtifact(await authorizedArtifact(request));
    },

    async listArtifacts(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      limit: number;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<ArtifactPage> {
      const pageLimit = limit(request.limit);
      const after = artifactCursor(request.cursor);
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      request.signal?.throwIfAborted();
      let page: {
        items: StoredArtifact[];
        next?: { updatedAt: string; artifactId: string };
      };
      try {
        page = await dependencies.artifacts.listArtifacts({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          limit: pageLimit,
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact listing failed.', error);
      }
      if (
        page.items.some(
          (item) =>
            item.installationId !== request.installationId ||
            item.workspaceId !== request.workspaceId,
        )
      ) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Artifact listing returned invalid scope.',
          new Error('Artifact catalog adapter crossed its requested scope.'),
        );
      }
      return {
        apiVersion: 'v1',
        items: page.items.map(storedArtifactToArtifact),
        nextCursor:
          page.next === undefined ? null : encodeCursor({ kind: 'artifacts', ...page.next }),
      };
    },

    async listArtifactRevisions(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      limit: number;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<ArtifactRevisionPage> {
      const pageLimit = limit(request.limit);
      const beforeRevisionNumber = revisionCursor(request.cursor);
      const stored = await authorizedArtifact(request);
      let page: { items: StoredArtifactRevision[]; nextRevisionNumber?: number };
      try {
        page = await dependencies.artifacts.listArtifactRevisions({
          installationId: request.installationId,
          artifactId: request.artifactId,
          limit: pageLimit,
          ...(beforeRevisionNumber === undefined ? {} : { beforeRevisionNumber }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact history lookup failed.', error);
      }
      return {
        apiVersion: 'v1',
        artifactId: stored.artifactId,
        workspaceId: stored.workspaceId,
        items: page.items.map(storedRevisionToArtifactRevision),
        nextCursor:
          page.nextRevisionNumber === undefined
            ? null
            : encodeCursor({
                kind: 'revisions',
                revisionNumber: page.nextRevisionNumber,
              }),
      };
    },
  };
}
