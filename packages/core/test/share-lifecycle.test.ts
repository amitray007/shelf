import { describe, expect, it, vi } from 'vitest';

import {
  createShareLifecycleService,
  type ShareRepository,
  type StoredShare,
} from '../src/index.js';

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  firstRevision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  secondRevision: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
  share: 'shr_DDDDDDDDDDDDDDDDDDDDDD',
};

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId: ids.artifact,
    kind: 'file' as const,
    name: 'Launch notes',
    createdAt: '2026-08-17T11:00:00.000Z',
    updatedAt: '2026-08-17T11:30:00.000Z',
    latestRevision: {
      kind: 'file' as const,
      revisionId: ids.secondRevision,
      revisionNumber: 2,
      originalFileName: 'launch.md',
      mediaType: 'text/markdown',
      contentHash: `sha256:${'c'.repeat(64)}`,
      byteCount: 84,
      createdAt: '2026-08-17T11:30:00.000Z',
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
      },
      publisherMetadata: { privateSource: 'agent-run' },
    },
    ...overrides,
  };
}

function repository(overrides: Partial<ShareRepository> = {}): ShareRepository {
  return {
    async findArtifactForShare() {
      return artifact();
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
      return undefined;
    },
    async revokeShare() {
      return { status: 'not-found' };
    },
    async resolveShareTarget() {
      return undefined;
    },
    ...overrides,
  };
}

const capabilityCodec = {
  deriveSecret() {
    return 's'.repeat(43);
  },
  validateSecret() {
    return true;
  },
};

function storedShare(overrides: Partial<StoredShare> = {}): StoredShare {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    shareId: ids.share,
    artifactId: ids.artifact,
    visibility: 'unlisted',
    target: { mode: 'latest' },
    createdByActorId: 'actor-publisher',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revokedByActorId: null,
    ...overrides,
  };
}

describe('share lifecycle service', () => {
  it('replays an identical create with the same canonical capability URL and conflicts on change', async () => {
    let idempotency: { fingerprint: string; result: Record<string, unknown> } | undefined;
    const commitCreate = vi.fn(async (input) => {
      if (idempotency === undefined) {
        idempotency = { fingerprint: input.fingerprint, result: input.result };
        return { status: 'committed' as const, result: input.result };
      }
      if (idempotency.fingerprint !== input.fingerprint) return { status: 'conflict' as const };
      return { status: 'replayed' as const, result: idempotency.result };
    });
    const authorization: unknown[] = [];
    const service = createShareLifecycleService({
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
      shares: {
        async findArtifactForShare() {
          return artifact();
        },
        async findRevisionForShare() {
          return undefined;
        },
        async findCreateIdempotency() {
          return idempotency;
        },
        commitCreate,
        async listShares() {
          return { items: [] };
        },
        async findShare() {
          return undefined;
        },
        async revokeShare() {
          return { status: 'not-found' as const };
        },
        async resolveShareTarget() {
          return undefined;
        },
      },
      capabilityCodec: {
        deriveSecret() {
          return 's'.repeat(43);
        },
        validateSecret() {
          return true;
        },
      },
      clock: () => new Date('2026-08-17T12:00:00.000Z'),
      generateShareId: () => ids.share,
    });
    const request = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      artifactId: ids.artifact,
      target: { mode: 'latest' as const },
      expiresAt: '2026-08-24T12:00:00.000Z',
      idempotencyKey: 'share-launch-notes',
      requestId: 'request-create-share',
    };

    const created = await service.createShare(request);
    const replayed = await service.createShare({ ...request, requestId: 'request-retry' });

    expect(created).toMatchObject({
      shareId: ids.share,
      replayed: false,
      url: `/s/${ids.share}#${'s'.repeat(43)}`,
    });
    expect(replayed).toMatchObject({
      shareId: ids.share,
      requestId: 'request-retry',
      replayed: true,
      url: created.url,
    });
    expect(authorization.map((value) => (value as { action: string }).action)).toEqual([
      'file.publish',
      'revision.read',
      'file.publish',
      'revision.read',
    ]);
    expect(commitCreate).toHaveBeenCalledTimes(1);

    await expect(
      service.createShare({
        ...request,
        expiresAt: '2026-08-25T12:00:00.000Z',
        requestId: 'request-conflict',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(commitCreate).toHaveBeenCalledTimes(1);
  });

  it('creates a pinned share only when the revision belongs to the artifact scope', async () => {
    const commitCreate = vi.fn(async (input) => ({
      status: 'committed' as const,
      result: input.result,
    }));
    const service = createShareLifecycleService({
      authorizer: { async authorize() {} },
      shares: repository({
        async findRevisionForShare() {
          return {
            installationId: 'installation-main',
            workspaceId: 'workspace-main',
            artifactId: ids.artifact,
            revision: artifact().latestRevision,
          };
        },
        commitCreate,
      }),
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:00:00.000Z'),
      generateShareId: () => ids.share,
    });

    await expect(
      service.createShare({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-publisher',
        artifactId: ids.artifact,
        target: { mode: 'pinned', revisionId: ids.secondRevision },
        idempotencyKey: 'pinned-launch-notes',
        requestId: 'request-pinned-share',
      }),
    ).resolves.toMatchObject({
      target: { mode: 'pinned', revisionId: ids.secondRevision },
      replayed: false,
    });
    expect(commitCreate).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'artifact from another workspace',
      repository({
        async findArtifactForShare() {
          return artifact({ workspaceId: 'workspace-other' });
        },
      }),
      { mode: 'latest' as const },
      'ARTIFACT_NOT_FOUND',
    ],
    [
      'pinned revision from another artifact',
      repository({
        async findRevisionForShare() {
          return {
            installationId: 'installation-main',
            workspaceId: 'workspace-main',
            artifactId: 'art_ZZZZZZZZZZZZZZZZZZZZZZ',
            revision: artifact().latestRevision,
          };
        },
      }),
      { mode: 'pinned' as const, revisionId: ids.secondRevision },
      'REVISION_NOT_FOUND',
    ],
  ])('rejects %s without mutating share state', async (_case, shares, target, errorCode) => {
    const commitCreate = vi.spyOn(shares, 'commitCreate');
    const service = createShareLifecycleService({
      authorizer: { async authorize() {} },
      shares,
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:00:00.000Z'),
      generateShareId: () => ids.share,
    });

    await expect(
      service.createShare({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-publisher',
        artifactId: ids.artifact,
        target,
        idempotencyKey: 'invalid-target',
        requestId: 'request-invalid-target',
      }),
    ).rejects.toMatchObject({ code: errorCode });
    expect(commitCreate).not.toHaveBeenCalled();
  });

  it('lists reusable workspace-scoped links with pinned revision identity', async () => {
    const authorization: unknown[] = [];
    const service = createShareLifecycleService({
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
      shares: repository({
        async findRevisionForShare() {
          return {
            installationId: 'installation-main',
            workspaceId: 'workspace-main',
            artifactId: ids.artifact,
            revision: artifact().latestRevision,
          };
        },
        async listShares() {
          return {
            items: [storedShare({ target: { mode: 'pinned', revisionId: ids.secondRevision } })],
          };
        },
      }),
      capabilityCodec,
    });

    const page = await service.listShares({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-reader',
      limit: 25,
    });

    expect(page).toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      items: [
        {
          apiVersion: 'v1',
          workspaceId: 'workspace-main',
          shareId: ids.share,
          artifactId: ids.artifact,
          visibility: 'unlisted',
          target: { mode: 'pinned', revisionId: ids.secondRevision, revisionNumber: 2 },
          createdAt: '2026-08-17T12:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          url: `/s/${ids.share}#${'s'.repeat(43)}`,
        },
      ],
      nextCursor: null,
    });
    expect(authorization).toEqual([
      {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        action: 'revision.read',
      },
    ]);
    expect(page.items[0]).toHaveProperty('url');
    expect(page.items[0]).not.toHaveProperty('createdByActorId');
  });

  it('makes repeated and concurrent revocation idempotent', async () => {
    let current = storedShare();
    const revokeShare = vi.fn(async (request) => {
      if (current.revokedAt !== null) {
        return { status: 'already-revoked' as const, result: current };
      }
      current = {
        ...current,
        revokedAt: request.revokedAt,
        revokedByActorId: request.revokedByActorId,
      };
      return { status: 'revoked' as const, result: current };
    });
    const service = createShareLifecycleService({
      authorizer: { async authorize() {} },
      shares: repository({
        async findShare() {
          return current;
        },
        revokeShare,
      }),
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:05:00.000Z'),
    });
    const request = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      shareId: ids.share,
    };

    const [first, concurrent] = await Promise.all([
      service.revokeShare(request),
      service.revokeShare(request),
    ]);
    const replayed = await service.revokeShare(request);

    expect(first.revokedAt).toBe('2026-08-17T12:05:00.000Z');
    expect(concurrent).toEqual(first);
    expect(replayed).toEqual(first);
    expect(revokeShare).toHaveBeenCalledTimes(3);
  });
});
