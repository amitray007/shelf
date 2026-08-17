import { describe, expect, it } from 'vitest';

import {
  createRevisionComparisonService,
  type RevisionComparisonRepository,
} from '../src/index.js';

const installationId = 'installation-main';
const workspaceId = 'workspace-main';
const artifactId = 'art_AAAAAAAAAAAAAAAAAAAAAA';
const baseRevisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';
const targetRevisionId = 'rev_BBBBBBBBBBBBBBBBBBBBBB';

describe('revision comparison module', () => {
  it('compares two immutable file descriptors without reading content', async () => {
    const revisions = new Map([
      [
        baseRevisionId,
        {
          kind: 'file' as const,
          installationId,
          workspaceId,
          artifactId,
          revisionId: baseRevisionId,
          content: {
            contentId: 'cnt-base',
            contentHash: `sha256:${'a'.repeat(64)}`,
            byteCount: 8,
          },
          originalFileName: 'README.md',
          mediaType: 'text/markdown',
        },
      ],
      [
        targetRevisionId,
        {
          kind: 'file' as const,
          installationId,
          workspaceId,
          artifactId,
          revisionId: targetRevisionId,
          content: {
            contentId: 'cnt-target',
            contentHash: `sha256:${'b'.repeat(64)}`,
            byteCount: 9,
          },
          originalFileName: 'README.md',
          mediaType: 'text/markdown',
        },
      ],
    ]);
    const repository: RevisionComparisonRepository = {
      async findComparableRevision(revisionId) {
        return revisions.get(revisionId);
      },
      async listFolderEntries() {
        throw new Error('file comparison must not enumerate a folder tree');
      },
    };
    const compare = createRevisionComparisonService({
      authorizer: { async authorize() {} },
      revisions: repository,
    });

    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId,
        limit: 100,
      }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      kind: 'file',
      workspaceId,
      artifactId,
      base: {
        revisionId: baseRevisionId,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 8,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      target: {
        revisionId: targetRevisionId,
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteCount: 9,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      status: 'changed',
      changes: { content: true, mediaType: false, originalFileName: false },
    });
  });

  it('identifies deterministic folder additions, removals, exact moves, and changes', async () => {
    const folderRevisions = new Map([
      [
        baseRevisionId,
        {
          kind: 'folder' as const,
          installationId,
          workspaceId,
          artifactId,
          revisionId: baseRevisionId,
          manifest: {
            contentId: 'cnt-base-manifest',
            contentHash: `sha256:${'a'.repeat(64)}`,
            byteCount: 300,
          },
          rootName: 'Project',
          totalByteCount: 15,
          fileCount: 3,
        },
      ],
      [
        targetRevisionId,
        {
          kind: 'folder' as const,
          installationId,
          workspaceId,
          artifactId,
          revisionId: targetRevisionId,
          manifest: {
            contentId: 'cnt-target-manifest',
            contentHash: `sha256:${'b'.repeat(64)}`,
            byteCount: 340,
          },
          rootName: 'Project',
          totalByteCount: 19,
          fileCount: 4,
        },
      ],
    ]);
    const file = (path: string, hash: string, byteCount = 4) => ({
      path,
      kind: 'file' as const,
      mediaType: 'text/plain',
      content: { contentId: `cnt-${path}`, contentHash: `sha256:${hash.repeat(64)}`, byteCount },
    });
    const entries = new Map([
      [
        baseRevisionId,
        [
          { path: 'docs', kind: 'directory' as const },
          file('docs/old.txt', 'c'),
          file('removed.txt', 'd'),
          file('changed.txt', 'e'),
          { path: 'shape', kind: 'directory' as const },
        ],
      ],
      [
        targetRevisionId,
        [
          { path: 'docs', kind: 'directory' as const },
          file('docs/new.txt', 'c'),
          file('added.txt', 'f'),
          file('changed.txt', 'f'),
          file('shape', 'g', 3),
        ],
      ],
    ]);
    const compare = createRevisionComparisonService({
      authorizer: { async authorize() {} },
      revisions: {
        async findComparableRevision(revisionId) {
          return folderRevisions.get(revisionId);
        },
        async listFolderEntries(request) {
          const ordered = entries.get(request.revisionId) ?? [];
          const remaining = ordered.filter(
            (entry) => request.afterPath === undefined || entry.path > request.afterPath,
          );
          const items = remaining.slice(0, request.limit);
          return remaining.length > request.limit
            ? { items, nextPath: items.at(-1)?.path }
            : { items };
        },
      },
    });

    const result = await compare({
      installationId,
      actorId: 'actor-reader',
      baseRevisionId,
      targetRevisionId,
      limit: 100,
    });

    expect(result).toMatchObject({
      kind: 'folder',
      workspaceId,
      artifactId,
      summary: { added: 1, removed: 1, moved: 1, changed: 2, unchanged: 1 },
      nextCursor: null,
    });
    expect(result.kind === 'folder' ? result.items : []).toEqual([
      expect.objectContaining({ status: 'added', path: 'added.txt' }),
      expect.objectContaining({ status: 'changed', path: 'changed.txt' }),
      expect.objectContaining({
        status: 'moved',
        fromPath: 'docs/old.txt',
        toPath: 'docs/new.txt',
      }),
      expect.objectContaining({ status: 'removed', path: 'removed.txt' }),
      expect.objectContaining({ status: 'changed', path: 'shape' }),
    ]);
  });

  it('keeps ambiguous duplicate byte identities as additions and removals', async () => {
    const folder = (revisionId: string, hash: string) => ({
      kind: 'folder' as const,
      installationId,
      workspaceId,
      artifactId,
      revisionId,
      manifest: {
        contentId: `cnt-${revisionId}`,
        contentHash: `sha256:${hash.repeat(64)}`,
        byteCount: 100,
      },
      rootName: 'Project',
      totalByteCount: 8,
      fileCount: 2,
    });
    const duplicate = (path: string) => ({
      path,
      kind: 'file' as const,
      mediaType: 'text/plain',
      content: {
        contentId: `cnt-${path}`,
        contentHash: `sha256:${'c'.repeat(64)}`,
        byteCount: 4,
      },
    });
    const revisions = new Map([
      [baseRevisionId, folder(baseRevisionId, 'a')],
      [targetRevisionId, folder(targetRevisionId, 'b')],
    ]);
    const entries = new Map([
      [baseRevisionId, [duplicate('old-a.txt'), duplicate('old-b.txt')]],
      [targetRevisionId, [duplicate('new-a.txt'), duplicate('new-b.txt')]],
    ]);
    const compare = createRevisionComparisonService({
      authorizer: { async authorize() {} },
      revisions: {
        async findComparableRevision(revisionId) {
          return revisions.get(revisionId);
        },
        async listFolderEntries(request) {
          return { items: entries.get(request.revisionId) ?? [] };
        },
      },
    });

    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      kind: 'folder',
      summary: { added: 2, removed: 2, moved: 0, changed: 0, unchanged: 0 },
    });
  });

  it('pages changed entries with a cursor bound to the revision pair', async () => {
    const folder = (revisionId: string, hash: string) => ({
      kind: 'folder' as const,
      installationId,
      workspaceId,
      artifactId,
      revisionId,
      manifest: {
        contentId: `cnt-${revisionId}`,
        contentHash: `sha256:${hash.repeat(64)}`,
        byteCount: 100,
      },
      rootName: 'Project',
      totalByteCount: 0,
      fileCount: 0,
    });
    const revisions = new Map([
      [baseRevisionId, folder(baseRevisionId, 'a')],
      [targetRevisionId, folder(targetRevisionId, 'b')],
    ]);
    const compare = createRevisionComparisonService({
      authorizer: { async authorize() {} },
      revisions: {
        async findComparableRevision(revisionId) {
          return revisions.get(revisionId);
        },
        async listFolderEntries(request) {
          return request.revisionId === targetRevisionId
            ? {
                items: ['a', 'b', 'c'].map((path) => ({
                  path,
                  kind: 'directory' as const,
                })),
              }
            : { items: [] };
        },
      },
    });

    const first = await compare({
      installationId,
      actorId: 'actor-reader',
      baseRevisionId,
      targetRevisionId,
      limit: 2,
    });
    expect(first).toMatchObject({
      kind: 'folder',
      items: [
        { status: 'added', path: 'a' },
        { status: 'added', path: 'b' },
      ],
    });
    expect(first.kind === 'folder' ? first.nextCursor : null).toEqual(expect.any(String));
    const cursor = first.kind === 'folder' ? first.nextCursor : null;
    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId,
        limit: 2,
        cursor: cursor ?? undefined,
      }),
    ).resolves.toMatchObject({ items: [{ status: 'added', path: 'c' }], nextCursor: null });
    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId: targetRevisionId,
        targetRevisionId: baseRevisionId,
        limit: 2,
        cursor: cursor ?? undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects missing and other-artifact revisions before tree enumeration', async () => {
    let treeReads = 0;
    const base = {
      kind: 'file' as const,
      installationId,
      workspaceId,
      artifactId,
      revisionId: baseRevisionId,
      content: { contentId: 'cnt-base', contentHash: `sha256:${'a'.repeat(64)}`, byteCount: 1 },
      originalFileName: 'a.txt',
      mediaType: 'text/plain',
    };
    const compare = createRevisionComparisonService({
      authorizer: { async authorize() {} },
      revisions: {
        async findComparableRevision(revisionId) {
          if (revisionId === baseRevisionId) return base;
          if (revisionId === targetRevisionId) {
            return { ...base, revisionId, artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB' };
          }
          if (revisionId === 'rev_DDDDDDDDDDDDDDDDDDDDDD') {
            return { ...base, revisionId, workspaceId: 'workspace-other' };
          }
          if (revisionId === 'rev_EEEEEEEEEEEEEEEEEEEEEE') {
            return { ...base, revisionId, installationId: 'installation-other' };
          }
        },
        async listFolderEntries() {
          treeReads += 1;
          return { items: [] };
        },
      },
    });

    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId: 'rev_DDDDDDDDDDDDDDDDDDDDDD',
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      compare({
        installationId,
        actorId: 'actor-reader',
        baseRevisionId,
        targetRevisionId: 'rev_EEEEEEEEEEEEEEEEEEEEEE',
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    expect(treeReads).toBe(0);
  });
});
