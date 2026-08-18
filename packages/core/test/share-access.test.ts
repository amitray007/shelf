import { describe, expect, it, vi } from 'vitest';

import {
  createShareAccessService,
  type FolderRevisionRepository,
  type ShareRepository,
} from '../src/index.js';

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  share: 'shr_CCCCCCCCCCCCCCCCCCCCCC',
};
function shares(overrides: Partial<ShareRepository> = {}): ShareRepository {
  const revision = {
    kind: 'file' as const,
    revisionId: ids.revision,
    revisionNumber: 1,
    originalFileName: 'launch.html',
    mediaType: 'text/html',
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteCount: 7,
    createdAt: '2026-08-17T12:00:00.000Z',
    provenance: {
      classification: 'direct-publish' as const,
      observed: { actorId: 'private-actor', operation: 'file.publish' as const },
    },
    publisherMetadata: { private: 'metadata' },
  };
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
      return {
        share: {
          apiVersion: 'v1',
          installationId: 'install-main',
          workspaceId: 'workspace-main',
          shareId: ids.share,
          artifactId: ids.artifact,
          visibility: 'unlisted',
          accessType: 'protected',
          publicCode: null,
          target: { mode: 'latest' },
          createdByActorId: 'private-actor',
          createdAt: '2026-08-17T12:00:00.000Z',
          expiresAt: null,
          maxSessions: null,
          sessionsUsed: 0,
          revokedAt: null,
          revokedByActorId: null,
        },
        artifact: {
          installationId: 'install-main',
          workspaceId: 'workspace-main',
          artifactId: ids.artifact,
          kind: 'file',
          name: 'Launch',
          createdAt: '2026-08-17T12:00:00.000Z',
          updatedAt: '2026-08-17T12:00:00.000Z',
          latestRevision: revision,
        },
        revision: {
          installationId: 'install-main',
          workspaceId: 'workspace-main',
          artifactId: ids.artifact,
          revision,
        },
      };
    },
    async resolvePublicShareTarget() {
      return undefined;
    },
    async establishProtectedSession() {
      return { status: 'unavailable' };
    },
    ...overrides,
  };
}

describe('public share access', () => {
  it('revalidates the capability and exact target before opening attachment-safe file bytes', async () => {
    const repository = shares();
    const resolveShareTarget = vi.spyOn(repository, 'resolveShareTarget');
    const read = vi.fn(async () =>
      (async function* bytes() {
        yield new TextEncoder().encode('<html>');
      })(),
    );
    const access = createShareAccessService({
      shares: repository,
      revisions: {
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
            artifactId: ids.artifact,
            revisionId: ids.revision,
            content: {
              contentId: 'private-storage-id',
              contentHash: `sha256:${'a'.repeat(64)}`,
              byteCount: 7,
            },
            originalFileName: 'launch.html',
            mediaType: 'text/html',
            provenance: {
              classification: 'direct-publish',
              observed: { actorId: 'private-actor', operation: 'file.publish' },
            },
            publisherMetadata: { private: 'metadata' },
          };
        },
      },
      folders: {
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
      },
      contentReader: { read },
    });

    const file = await access.readFile({
      authority: {
        type: 'protected-session',
        shareId: ids.share,
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    const chunks = [];
    for await (const chunk of await file.read()) chunks.push(chunk);

    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe('<html>');
    expect(file).toMatchObject({
      revisionId: ids.revision,
      originalFileName: 'launch.html',
      byteCount: 7,
    });
    expect(resolveShareTarget).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      expect.not.objectContaining({ contentId: undefined }),
      expect.objectContaining({}),
    );
    expect(JSON.stringify(file)).not.toMatch(/private|actor|workspace|installation|provider/i);
  });

  it('returns a sanitized, bounded tree and refuses tree access for file shares', async () => {
    const access = createShareAccessService({
      shares: shares(),
      revisions: {
        async findIdempotency() {
          return undefined;
        },
        async commitPublish(input) {
          return { status: 'committed', result: input.result };
        },
        async findRevision() {
          return undefined;
        },
      },
      folders: {
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
      } satisfies FolderRevisionRepository,
      contentReader: {
        async read() {
          throw new Error('not used');
        },
      },
    });

    await expect(
      access.readTree({
        authority: {
          type: 'protected-session',
          shareId: ids.share,
          sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'SHARE_NOT_FOUND' });
  });

  it('reads the same content through a secretless Public selector', async () => {
    const protectedRepository = shares();
    const repository = shares({
      async resolvePublicShareTarget() {
        const resolved = await protectedRepository.resolveShareTarget(ids.share);
        if (resolved === undefined) return undefined;
        return {
          ...resolved,
          share: {
            ...resolved.share,
            accessType: 'public',
            publicCode: 'PublicCode12',
            expiresAt: '2026-08-19T12:00:00.000Z',
          },
        };
      },
    });
    const access = createShareAccessService({
      shares: repository,
      revisions: {
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
            artifactId: ids.artifact,
            revisionId: ids.revision,
            content: {
              contentId: 'private-storage-id',
              contentHash: `sha256:${'a'.repeat(64)}`,
              byteCount: 7,
            },
            originalFileName: 'launch.html',
            mediaType: 'text/html',
            provenance: {
              classification: 'direct-publish',
              observed: { actorId: 'private-actor', operation: 'file.publish' },
            },
            publisherMetadata: {},
          };
        },
      },
      folders: {
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
      },
      contentReader: {
        async read() {
          return (async function* bytes() {
            yield new TextEncoder().encode('<html>');
          })();
        },
      },
      clock: () => new Date('2026-08-18T12:00:00.000Z'),
    });

    await expect(
      access.readFile({ authority: { type: 'public', publicCode: 'PublicCode12' } }),
    ).resolves.toMatchObject({ revisionId: ids.revision });
  });
});
