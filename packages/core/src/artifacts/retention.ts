import type { Artifact, ArtifactRetentionMode, TrashedArtifact, TrashPage } from '@shelf/contracts';
import { PUBLISH_OPERATION, READ_REVISION_OPERATION } from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { Authorizer } from '../publishing/ports.js';
import { ArtifactNotFoundError } from '../publishing/publish.js';
import { type StoredArtifact, storedArtifactToArtifact } from './catalog.js';

const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{22}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

export interface StoredTrashedArtifact {
  artifact: StoredArtifact;
  deletedAt: string;
  purgeAt: string;
  reason: 'manual' | 'retention';
}

export interface ArtifactRetentionRepository {
  setArtifactRetention(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    mode: ArtifactRetentionMode;
    changedAt: string;
  }): Promise<StoredArtifact | undefined>;
  findTrashedArtifact(artifactId: string): Promise<StoredTrashedArtifact | undefined>;
  listTrashedArtifacts(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    search?: string;
    after?: { deletedAt: string; artifactId: string };
  }): Promise<{
    items: StoredTrashedArtifact[];
    next?: { deletedAt: string; artifactId: string };
  }>;
}

export class InvalidArtifactRetentionRequestError extends ShelfCoreError {
  constructor(field: 'artifactId' | 'cursor' | 'limit' | 'mode' | 'search') {
    super('INVALID_REQUEST', 'The artifact retention request is invalid.', {
      retryable: false,
      details: [{ field, reason: `must be a valid ${field}` }],
    });
    this.name = 'InvalidArtifactRetentionRequestError';
  }
}

function trashItem(stored: StoredTrashedArtifact): TrashedArtifact {
  return {
    apiVersion: 'v1',
    artifact: storedArtifactToArtifact(stored.artifact),
    deletedAt: stored.deletedAt,
    purgeAt: stored.purgeAt,
    reason: stored.reason,
  };
}

function encodeCursor(value: { deletedAt: string; artifactId: string; search?: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: 'trash', ...value }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(value: string | undefined, search: string | undefined) {
  if (value === undefined) return undefined;
  try {
    if (!CURSOR_PATTERN.test(value)) throw new Error('invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      parsed.v !== 1 ||
      parsed.kind !== 'trash' ||
      parsed.search !== search ||
      typeof parsed.deletedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.deletedAt)) ||
      typeof parsed.artifactId !== 'string' ||
      !ARTIFACT_ID_PATTERN.test(parsed.artifactId)
    ) {
      throw new Error('invalid cursor');
    }
    return { deletedAt: parsed.deletedAt, artifactId: parsed.artifactId };
  } catch {
    throw new InvalidArtifactRetentionRequestError('cursor');
  }
}

function normalizedSearch(value: string | undefined): string | undefined {
  const search = value?.trim();
  if (search === undefined || search.length === 0) return undefined;
  if (search.length > 200) throw new InvalidArtifactRetentionRequestError('search');
  return search;
}

export function createArtifactRetentionService(dependencies: {
  authorizer: Authorizer;
  artifacts: ArtifactRetentionRepository;
  clock?: () => Date;
}) {
  const clock = dependencies.clock ?? (() => new Date());

  return {
    async setRetention(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      artifactId: string;
      mode: ArtifactRetentionMode;
      signal?: AbortSignal;
    }): Promise<Artifact> {
      if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new InvalidArtifactRetentionRequestError('artifactId');
      }
      if (request.mode !== 'automatic' && request.mode !== 'keep') {
        throw new InvalidArtifactRetentionRequestError('mode');
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: PUBLISH_OPERATION,
        },
        request.signal,
      );
      let artifact: StoredArtifact | undefined;
      try {
        artifact = await dependencies.artifacts.setArtifactRetention({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          artifactId: request.artifactId,
          mode: request.mode,
          changedAt: clock().toISOString(),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact retention update failed.', error);
      }
      if (artifact === undefined) throw new ArtifactNotFoundError();
      return storedArtifactToArtifact(artifact);
    },

    async getTrash(request: {
      installationId: string;
      actorId: string;
      artifactId: string;
      signal?: AbortSignal;
    }): Promise<TrashedArtifact> {
      if (!ARTIFACT_ID_PATTERN.test(request.artifactId)) {
        throw new InvalidArtifactRetentionRequestError('artifactId');
      }
      let item: StoredTrashedArtifact | undefined;
      try {
        item = await dependencies.artifacts.findTrashedArtifact(request.artifactId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Trash lookup failed.', error);
      }
      if (item === undefined || item.artifact.installationId !== request.installationId) {
        throw new ArtifactNotFoundError();
      }
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: item.artifact.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      return trashItem(item);
    },

    async listTrash(request: {
      installationId: string;
      workspaceId: string;
      actorId: string;
      limit: number;
      search?: string;
      cursor?: string;
      signal?: AbortSignal;
    }): Promise<TrashPage> {
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new InvalidArtifactRetentionRequestError('limit');
      }
      const search = normalizedSearch(request.search);
      const after = decodeCursor(request.cursor, search);
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
      let page: Awaited<ReturnType<ArtifactRetentionRepository['listTrashedArtifacts']>>;
      try {
        page = await dependencies.artifacts.listTrashedArtifacts({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          limit: request.limit,
          ...(search === undefined ? {} : { search }),
          ...(after === undefined ? {} : { after }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Trash listing failed.', error);
      }
      return {
        apiVersion: 'v1',
        items: page.items.map(trashItem),
        nextCursor:
          page.next === undefined
            ? null
            : encodeCursor({ ...page.next, ...(search === undefined ? {} : { search }) }),
      };
    },
  };
}
