import { describe, expect, it } from 'vitest';

import { type ArtifactCatalogRepository, createArtifactCatalogService } from '../src/index.js';

const storedRevision = {
  kind: 'file' as const,
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  revisionNumber: 2,
  originalFileName: 'CHANGELOG.md',
  mediaType: 'text/markdown',
  contentHash: `sha256:${'b'.repeat(64)}`,
  byteCount: 24,
  fileCount: 1,
  createdAt: '2026-08-17T12:01:00.000Z',
  provenance: {
    classification: 'direct-publish' as const,
    observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
  },
  publisherMetadata: { source: 'agent' },
};

const storedArtifact = {
  installationId: 'installation-main',
  workspaceId: 'workspace-main',
  artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'file' as const,
  name: 'Release notes',
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:01:00.000Z',
  retentionMode: 'automatic' as const,
  autoTrashAt: '2026-09-16T12:01:00.000Z',
  latestRevision: storedRevision,
};

function repository(): ArtifactCatalogRepository {
  return {
    async findArtifact() {
      return storedArtifact;
    },
    async listArtifacts() {
      return { items: [storedArtifact] };
    },
    async listArtifactRevisions() {
      return { items: [storedRevision] };
    },
  };
}

describe('artifact catalog service', () => {
  it('returns canonical artifact detail after workspace read authorization', async () => {
    const authorization: unknown[] = [];
    const catalog = createArtifactCatalogService({
      artifacts: repository(),
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
    });

    await expect(
      catalog.getArtifact({
        installationId: 'installation-main',
        actorId: 'actor-reader',
        artifactId: storedArtifact.artifactId,
      }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId: storedArtifact.artifactId,
      kind: 'file',
      name: 'Release notes',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:01:00.000Z',
      retention: { mode: 'automatic', trashAt: '2026-09-16T12:01:00.000Z' },
      latestRevision: {
        ...storedRevision,
        paths: {
          revision: `/api/v1/revisions/${storedRevision.revisionId}`,
          content: `/api/v1/revisions/${storedRevision.revisionId}/content`,
        },
      },
      paths: {
        artifact: `/api/v1/artifacts/${storedArtifact.artifactId}`,
        revisions: `/api/v1/artifacts/${storedArtifact.artifactId}/revisions`,
      },
    });
    expect(authorization).toEqual([
      {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        action: 'revision.read',
      },
    ]);
  });

  it('does not enumerate an artifact across installation boundaries', async () => {
    let authorizationCalls = 0;
    const catalog = createArtifactCatalogService({
      artifacts: repository(),
      authorizer: {
        async authorize() {
          authorizationCalls += 1;
        },
      },
    });

    await expect(
      catalog.getArtifact({
        installationId: 'installation-other',
        actorId: 'actor-reader',
        artifactId: storedArtifact.artifactId,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    expect(authorizationCalls).toBe(0);
  });

  it('fails closed when lookup returns a different artifact identity', async () => {
    const catalog = createArtifactCatalogService({
      artifacts: {
        ...repository(),
        async findArtifact() {
          return { ...storedArtifact, artifactId: 'art_CCCCCCCCCCCCCCCCCCCCCC' };
        },
      },
      authorizer: { async authorize() {} },
    });

    await expect(
      catalog.getArtifact({
        installationId: 'installation-main',
        actorId: 'actor-reader',
        artifactId: storedArtifact.artifactId,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
  });

  it('returns deterministic bounded artifact pages through an opaque cursor', async () => {
    const artifacts: ArtifactCatalogRepository = {
      ...repository(),
      async listArtifacts(request) {
        if (request.after !== undefined) return { items: [] };
        return {
          items: [storedArtifact],
          next: { timestamp: storedArtifact.updatedAt, artifactId: storedArtifact.artifactId },
        };
      },
    };
    const catalog = createArtifactCatalogService({
      artifacts,
      authorizer: { async authorize() {} },
    });

    const first = await catalog.listArtifacts({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-reader',
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(
      catalog.listArtifacts({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        limit: 1,
        cursor: first.nextCursor as string,
      }),
    ).resolves.toEqual({ apiVersion: 'v1', items: [], nextCursor: null });

    await expect(
      catalog.listArtifacts({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        limit: 1,
        sort: 'created',
        order: 'asc',
        cursor: first.nextCursor as string,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('passes normalized search terms to the repository and scopes cursors to them', async () => {
    const requests: Array<{ search?: string }> = [];
    const artifacts: ArtifactCatalogRepository = {
      ...repository(),
      async listArtifacts(request) {
        requests.push(request);
        return {
          items: [storedArtifact],
          next: { timestamp: storedArtifact.updatedAt, artifactId: storedArtifact.artifactId },
        };
      },
    };
    const catalog = createArtifactCatalogService({
      artifacts,
      authorizer: { async authorize() {} },
    });

    const first = await catalog.listArtifacts({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-reader',
      limit: 10,
      search: '  changelog  ',
    });
    expect(requests[0]?.search).toBe('changelog');

    await expect(
      catalog.listArtifacts({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        limit: 10,
        search: 'README',
        cursor: first.nextCursor as string,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects a malformed opaque cursor as a canonical invalid request', async () => {
    const catalog = createArtifactCatalogService({
      artifacts: repository(),
      authorizer: { async authorize() {} },
    });
    const malformed = Buffer.from(
      JSON.stringify({ v: 1, kind: 'artifacts', updatedAt: 'not-a-date', artifactId: 'art_x' }),
    ).toString('base64url');

    await expect(
      catalog.listArtifacts({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        limit: 20,
        cursor: malformed,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('fails closed when a catalog adapter returns another workspace', async () => {
    const catalog = createArtifactCatalogService({
      artifacts: {
        ...repository(),
        async listArtifacts() {
          return { items: [{ ...storedArtifact, workspaceId: 'workspace-other' }] };
        },
      },
      authorizer: { async authorize() {} },
    });

    await expect(
      catalog.listArtifacts({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('pages one artifact history in either global order with order-bound cursors', async () => {
    const firstRevision = {
      ...storedRevision,
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      revisionNumber: 1,
      originalFileName: 'README.md',
      createdAt: '2026-08-17T12:00:00.000Z',
    };
    const artifacts: ArtifactCatalogRepository = {
      ...repository(),
      async listArtifactRevisions(request) {
        if (request.order === 'oldest') {
          return request.cursorRevisionNumber === undefined
            ? { items: [firstRevision], nextRevisionNumber: firstRevision.revisionNumber }
            : { items: [storedRevision] };
        }
        return request.cursorRevisionNumber === undefined
          ? { items: [storedRevision], nextRevisionNumber: storedRevision.revisionNumber }
          : { items: [firstRevision] };
      },
    };
    const catalog = createArtifactCatalogService({
      artifacts,
      authorizer: { async authorize() {} },
    });

    const newest = await catalog.listArtifactRevisions({
      installationId: 'installation-main',
      actorId: 'actor-reader',
      artifactId: storedArtifact.artifactId,
      limit: 1,
    });
    const older = await catalog.listArtifactRevisions({
      installationId: 'installation-main',
      actorId: 'actor-reader',
      artifactId: storedArtifact.artifactId,
      limit: 1,
      cursor: newest.nextCursor as string,
    });
    const oldest = await catalog.listArtifactRevisions({
      installationId: 'installation-main',
      actorId: 'actor-reader',
      artifactId: storedArtifact.artifactId,
      limit: 1,
      order: 'oldest',
    });
    const newer = await catalog.listArtifactRevisions({
      installationId: 'installation-main',
      actorId: 'actor-reader',
      artifactId: storedArtifact.artifactId,
      limit: 1,
      order: 'oldest',
      cursor: oldest.nextCursor as string,
    });

    expect(newest.items.map((item) => item.revisionNumber)).toEqual([2]);
    expect(older.items.map((item) => item.revisionNumber)).toEqual([1]);
    expect(older.nextCursor).toBeNull();
    expect(oldest.items.map((item) => item.revisionNumber)).toEqual([1]);
    expect(newer.items.map((item) => item.revisionNumber)).toEqual([2]);
    await expect(
      catalog.listArtifactRevisions({
        installationId: 'installation-main',
        actorId: 'actor-reader',
        artifactId: storedArtifact.artifactId,
        limit: 1,
        order: 'oldest',
        cursor: newest.nextCursor as string,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
