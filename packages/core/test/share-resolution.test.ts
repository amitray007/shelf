import { describe, expect, it, vi } from 'vitest';

import {
  createShareResolutionService,
  type ShareRepository,
  type StoredShare,
} from '../src/index.js';

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  firstRevision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  secondRevision: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
  latestShare: 'shr_DDDDDDDDDDDDDDDDDDDDDD',
  pinnedShare: 'shr_EEEEEEEEEEEEEEEEEEEEEE',
};
const validSecret = 'v'.repeat(43);
const wrongSecret = 'w'.repeat(43);

function fileRevision(revisionId: string, revisionNumber: number) {
  return {
    kind: 'file' as const,
    revisionId,
    revisionNumber,
    originalFileName: 'launch.md',
    mediaType: 'text/markdown',
    contentHash: `sha256:${revisionNumber.toString(16).padStart(64, '0')}`,
    byteCount: 84 + revisionNumber,
    createdAt: `2026-08-17T12:0${revisionNumber}:00.000Z`,
    provenance: {
      classification: 'direct-publish' as const,
      observed: { actorId: 'actor-private', operation: 'file.publish' as const },
    },
    publisherMetadata: { privateSource: 'agent-run' },
  };
}

function share(shareId: string, overrides: Partial<StoredShare> = {}): StoredShare {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    shareId,
    artifactId: ids.artifact,
    visibility: 'unlisted',
    target: { mode: 'latest' },
    createdByActorId: 'actor-private',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revokedByActorId: null,
    ...overrides,
  };
}

function repository(overrides: Partial<ShareRepository>): ShareRepository {
  return {
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
  validateSecret(_shareId: string, secret: string) {
    return secret === validSecret;
  },
};

describe('anonymous share resolution', () => {
  it('advances a latest target on every request while keeping a pinned target exact', async () => {
    const first = fileRevision(ids.firstRevision, 1);
    let current = first;
    const latest = share(ids.latestShare);
    const pinned = share(ids.pinnedShare, {
      target: { mode: 'pinned', revisionId: ids.firstRevision },
    });
    const resolve = createShareResolutionService({
      shares: repository({
        async resolveShareTarget(shareId) {
          const stored = shareId === ids.latestShare ? latest : pinned;
          const revision = stored.target.mode === 'latest' ? current : first;
          return {
            share: stored,
            artifact: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              kind: 'file',
              name: 'Launch notes',
              createdAt: '2026-08-17T11:00:00.000Z',
              updatedAt: current.createdAt,
              latestRevision: current,
            },
            revision: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              revision,
            },
          };
        },
      }),
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
    });

    await expect(resolve({ shareId: ids.latestShare, secret: validSecret })).resolves.toMatchObject(
      { revision: { revisionId: ids.firstRevision } },
    );
    current = fileRevision(ids.secondRevision, 2);
    await expect(resolve({ shareId: ids.latestShare, secret: validSecret })).resolves.toMatchObject(
      { revision: { revisionId: ids.secondRevision } },
    );
    await expect(resolve({ shareId: ids.pinnedShare, secret: validSecret })).resolves.toMatchObject(
      { revision: { revisionId: ids.firstRevision } },
    );
  });

  it('collapses invalid, missing, revoked, and exactly expired capabilities to one miss', async () => {
    const expired = share(ids.latestShare, { expiresAt: '2026-08-17T12:30:00.000Z' });
    const find = vi.fn(async () => undefined);
    const resolveMissing = createShareResolutionService({
      shares: repository({ resolveShareTarget: find }),
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
    });
    const revision = fileRevision(ids.firstRevision, 1);
    const record = (stored: StoredShare) => ({
      share: stored,
      artifact: {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        artifactId: ids.artifact,
        kind: 'file' as const,
        name: 'Launch notes',
        createdAt: '2026-08-17T11:00:00.000Z',
        updatedAt: revision.createdAt,
        latestRevision: revision,
      },
      revision: {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        artifactId: ids.artifact,
        revision,
      },
    });
    const resolveExpired = createShareResolutionService({
      shares: repository({
        async resolveShareTarget() {
          return record(expired);
        },
      }),
      capabilityCodec,
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
    });
    const resolveRevoked = createShareResolutionService({
      shares: repository({
        async resolveShareTarget() {
          return record(share(ids.latestShare, { revokedAt: '2026-08-17T12:15:00.000Z' }));
        },
      }),
      capabilityCodec,
    });

    for (const promise of [
      resolveMissing({ shareId: ids.latestShare, secret: wrongSecret }),
      resolveMissing({ shareId: ids.latestShare, secret: validSecret }),
      resolveExpired({ shareId: ids.latestShare, secret: validSecret }),
      resolveRevoked({ shareId: ids.latestShare, secret: validSecret }),
      resolveMissing({ shareId: 'not-a-share', secret: validSecret }),
    ]) {
      await expect(promise).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
    }
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('returns a sanitized file projection with only a public content action', async () => {
    const revision = fileRevision(ids.secondRevision, 2);
    const resolve = createShareResolutionService({
      shares: repository({
        async resolveShareTarget() {
          return {
            share: share(ids.latestShare),
            artifact: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              kind: 'file',
              name: 'Launch notes',
              createdAt: '2026-08-17T11:00:00.000Z',
              updatedAt: revision.createdAt,
              latestRevision: revision,
            },
            revision: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              revision,
            },
          };
        },
      }),
      capabilityCodec,
    });

    const result = await resolve({ shareId: ids.latestShare, secret: validSecret });

    expect(result).toEqual({
      apiVersion: 'v1',
      shareId: ids.latestShare,
      target: { mode: 'latest' },
      artifact: { artifactId: ids.artifact, kind: 'file', name: 'Launch notes' },
      revision: {
        kind: 'file',
        revisionId: ids.secondRevision,
        revisionNumber: 2,
        createdAt: revision.createdAt,
        originalFileName: 'launch.md',
        mediaType: 'text/markdown',
        byteCount: revision.byteCount,
      },
      action: {
        type: 'content',
        path: `/api/v1/public/shares/${ids.latestShare}/content`,
      },
      expiresAt: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /workspace|installation|actor|publisher|provenance|contentHash|contentId|storage/i,
    );
  });

  it('returns a sanitized folder projection with a public tree action', async () => {
    const revision = {
      kind: 'folder' as const,
      revisionId: ids.firstRevision,
      revisionNumber: 1,
      rootName: 'prototype',
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 2048,
      fileCount: 7,
      createdAt: '2026-08-17T12:01:00.000Z',
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-private', operation: 'file.publish' as const },
      },
      publisherMetadata: { privateSource: 'agent-run' },
    };
    const stored = share(ids.pinnedShare, {
      target: { mode: 'pinned', revisionId: ids.firstRevision },
    });
    const resolve = createShareResolutionService({
      shares: repository({
        async resolveShareTarget() {
          return {
            share: stored,
            artifact: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              kind: 'folder',
              name: 'Prototype',
              createdAt: '2026-08-17T11:00:00.000Z',
              updatedAt: revision.createdAt,
              latestRevision: revision,
            },
            revision: {
              installationId: 'installation-main',
              workspaceId: 'workspace-main',
              artifactId: ids.artifact,
              revision,
            },
          };
        },
      }),
      capabilityCodec,
    });

    await expect(resolve({ shareId: ids.pinnedShare, secret: validSecret })).resolves.toEqual({
      apiVersion: 'v1',
      shareId: ids.pinnedShare,
      target: { mode: 'pinned', revisionId: ids.firstRevision },
      artifact: { artifactId: ids.artifact, kind: 'folder', name: 'Prototype' },
      revision: {
        kind: 'folder',
        revisionId: ids.firstRevision,
        revisionNumber: 1,
        createdAt: revision.createdAt,
        rootName: 'prototype',
        byteCount: 2048,
        fileCount: 7,
      },
      action: {
        type: 'tree',
        path: `/api/v1/public/shares/${ids.pinnedShare}/tree`,
      },
      expiresAt: null,
    });
  });
});
