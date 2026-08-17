import { describe, expect, it } from 'vitest';

import {
  canonicalFolderManifest,
  createArtifactLifecycleService,
  createFolderPublishService,
  createFolderTreeService,
  normalizePortableFolderPath,
  validateFolderManifestInput,
} from '../src/index.js';

describe('folder snapshot module', () => {
  it('restores a folder by referencing its immutable manifest and entry set', async () => {
    const source = {
      apiVersion: 'v1' as const,
      kind: 'folder' as const,
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      manifest: {
        contentId: 'cnt_manifest',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 180,
      },
      rootName: 'Project',
      totalByteCount: 7,
      fileCount: 1,
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-agent', operation: 'file.publish' as const },
      },
      publisherMetadata: { source: 'test' },
    };
    let committed: unknown;
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {
        async findArtifact() {
          return {
            installationId: source.installationId,
            workspaceId: source.workspaceId,
            artifactId: source.artifactId,
            kind: 'folder' as const,
            name: source.rootName,
            createdAt: '2026-08-17T12:00:00.000Z',
            updatedAt: '2026-08-17T12:00:00.000Z',
            latestRevision: {
              kind: 'folder' as const,
              revisionId: source.revisionId,
              revisionNumber: 1,
              rootName: source.rootName,
              contentHash: source.manifest.contentHash,
              byteCount: source.totalByteCount,
              fileCount: source.fileCount,
              createdAt: '2026-08-17T12:00:00.000Z',
              provenance: source.provenance,
              publisherMetadata: source.publisherMetadata,
            },
          };
        },
        async renameArtifact() {},
        async findRevision() {},
        async findFolderRevision() {
          return source;
        },
        async findRestoreIdempotency() {},
        async commitRestore(input) {
          committed = input;
          return { status: 'committed' as const, result: input.result, revisionNumber: 2 };
        },
      },
      generateId() {
        return 'rev_BBBBBBBBBBBBBBBBBBBBBB';
      },
    });

    const result = await lifecycle.restoreArtifact({
      installationId: source.installationId,
      workspaceId: source.workspaceId,
      actorId: 'actor-restorer',
      artifactId: source.artifactId,
      sourceRevisionId: source.revisionId,
      idempotencyKey: 'restore-folder-one',
      requestId: 'request-restore-folder',
    });

    expect(result).toMatchObject({
      kind: 'folder',
      revisionNumber: 2,
      sourceRevisionId: source.revisionId,
      contentHash: source.manifest.contentHash,
      byteCount: 7,
      fileCount: 1,
      paths: { tree: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB/tree' },
    });
    expect(committed).toMatchObject({
      result: {
        kind: 'folder',
        manifest: source.manifest,
        provenance: { classification: 'restore', source: { revisionId: source.revisionId } },
      },
    });
  });

  it('pages an authorized immutable tree in portable path order', async () => {
    const revision = {
      apiVersion: 'v1' as const,
      kind: 'folder' as const,
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      manifest: {
        contentId: 'cnt_manifest',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 200,
      },
      rootName: 'Project',
      totalByteCount: 7,
      fileCount: 1,
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-agent', operation: 'file.publish' as const },
      },
      publisherMetadata: {},
    };
    const entries = [
      { path: 'docs', kind: 'directory' as const },
      {
        path: 'docs/README.md',
        kind: 'file' as const,
        mediaType: 'text/markdown',
        content: {
          contentId: 'cnt_readme',
          contentHash: `sha256:${'b'.repeat(64)}`,
          byteCount: 7,
        },
      },
      { path: 'empty', kind: 'directory' as const },
    ];
    const tree = createFolderTreeService({
      authorizer: { async authorize() {} },
      folders: {
        async findFolderRevision() {
          return revision;
        },
        async listFolderEntries(request) {
          const after = request.afterPath;
          const items = entries.filter((entry) => after === undefined || entry.path > after);
          return items.length > request.limit
            ? { items: items.slice(0, request.limit), nextPath: items[request.limit - 1]?.path }
            : { items };
        },
      },
    });

    const first = await tree({
      installationId: revision.installationId,
      actorId: 'actor-reader',
      revisionId: revision.revisionId,
      limit: 2,
    });
    expect(first).toMatchObject({
      revisionId: revision.revisionId,
      byteCount: 7,
      fileCount: 1,
      items: [
        { path: 'docs', kind: 'directory' },
        { path: 'docs/README.md', kind: 'file', byteCount: 7 },
      ],
    });
    expect(first.nextCursor).not.toBeNull();
    await expect(
      tree({
        installationId: revision.installationId,
        actorId: 'actor-reader',
        revisionId: revision.revisionId,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      }),
    ).resolves.toMatchObject({ items: [{ path: 'empty', kind: 'directory' }], nextCursor: null });
  });

  it('publishes one complete snapshot and exposes it only through the atomic commit', async () => {
    const staged = new Map<string, Uint8Array>();
    let nextStage = 0;
    let committed: unknown;
    const publish = createFolderPublishService({
      authorizer: { async authorize() {} },
      artifactRepository: { async findArtifactIdentity() {} },
      contentStore: {
        async stage(content) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of content) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          const stageId = `stage-${nextStage++}`;
          staged.set(stageId, bytes);
          return { stageId };
        },
        async discard(value) {
          staged.delete(value.stageId);
        },
        async seal(value, descriptor) {
          const bytes = staged.get(value.stageId);
          if (bytes === undefined) throw new Error('missing staged fixture');
          staged.delete(value.stageId);
          return { contentId: `cnt-${value.stageId}`, ...descriptor };
        },
      },
      folderRepository: {
        async findFolderIdempotency() {
          return undefined;
        },
        async commitFolderPublish(input) {
          committed = input;
          return { status: 'committed' as const, result: input.result };
        },
      },
      generateId(kind) {
        return kind === 'art' ? 'art_AAAAAAAAAAAAAAAAAAAAAA' : 'rev_AAAAAAAAAAAAAAAAAAAAAA';
      },
    });
    const bytes = (value: string) =>
      (async function* content() {
        yield new TextEncoder().encode(value);
      })();

    const result = await publish({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-agent',
      requestId: 'request-folder',
      idempotencyKey: 'folder-1',
      publisherMetadata: { source: 'test' },
      manifest: {
        version: 'shelf-folder-manifest/v1',
        rootName: 'Project',
        entries: [
          { path: 'docs', kind: 'directory' },
          { path: 'docs/README.md', kind: 'file', mediaType: 'text/markdown' },
          { path: 'empty', kind: 'directory' },
          { path: 'index.html', kind: 'file', mediaType: 'text/html' },
        ],
      },
      files: [bytes('# Shelf'), bytes('<h1>Shelf</h1>')],
    });

    expect(result).toMatchObject({
      kind: 'folder',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      byteCount: 21,
      fileCount: 2,
      replayed: false,
      paths: { tree: '/api/v1/revisions/rev_AAAAAAAAAAAAAAAAAAAAAA/tree' },
    });
    expect(committed).toMatchObject({
      result: {
        kind: 'folder',
        rootName: 'Project',
        totalByteCount: 21,
        fileCount: 2,
      },
      entries: [
        { path: 'docs', kind: 'directory' },
        { path: 'docs/README.md', kind: 'file', content: { byteCount: 7 } },
        { path: 'empty', kind: 'directory' },
        { path: 'index.html', kind: 'file', content: { byteCount: 14 } },
      ],
    });
    expect(staged.size).toBe(0);
  });

  it('normalizes paths and hashes one deterministic canonical manifest', () => {
    expect(normalizePortableFolderPath('docs/cafe\u0301.md')).toBe('docs/café.md');

    const manifest = canonicalFolderManifest([
      {
        path: 'notes.txt',
        kind: 'file',
        mediaType: 'text/plain',
        content: {
          contentId: 'cnt_notes',
          contentHash: `sha256:${'b'.repeat(64)}`,
          byteCount: 5,
        },
      },
      { path: 'empty', kind: 'directory' },
    ]);

    expect(new TextDecoder().decode(manifest.bytes)).toBe(
      `{"version":"shelf-folder-manifest/v1","entries":[{"path":"empty","kind":"directory"},{"path":"notes.txt","kind":"file","mediaType":"text/plain","contentHash":"sha256:${'b'.repeat(64)}","byteCount":5}]}`,
    );
    expect(manifest.contentHash).toBe(
      'sha256:ff9fbc921f93d30e6bffdfb0db0f104fd88651b64a6d7be1650ffe0fc05ae3e8',
    );
    expect(manifest.fileCount).toBe(1);
    expect(manifest.byteCount).toBe(5);
  });

  it.each([
    '/absolute',
    '../escape',
    'a/./b',
    'a//b',
    'a\\b',
    'CON/readme.md',
    'trailing./file.txt',
    `control\u0000/file.txt`,
    `${Array.from({ length: 65 }, () => 'a').join('/')}/file.txt`,
  ])('rejects the non-portable path %j', (path) => {
    expect(() => normalizePortableFolderPath(path)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('rejects normalization and case-insensitive aliases before content is consumed', () => {
    expect(() =>
      validateFolderManifestInput({
        version: 'shelf-folder-manifest/v1',
        rootName: 'Project',
        entries: [
          { path: 'docs/café.md', kind: 'file', mediaType: 'text/markdown' },
          { path: 'docs/cafe\u0301.md', kind: 'file', mediaType: 'text/markdown' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));

    expect(() =>
      validateFolderManifestInput({
        version: 'shelf-folder-manifest/v1',
        rootName: 'Project',
        entries: [
          { path: 'README.md', kind: 'file', mediaType: 'text/markdown' },
          { path: 'readme.md', kind: 'file', mediaType: 'text/markdown' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('discards the failing and not-yet-sealed stages without a metadata commit', async () => {
    const remaining = new Set<string>();
    let nextStage = 0;
    let seals = 0;
    let commits = 0;
    const publish = createFolderPublishService({
      authorizer: { async authorize() {} },
      artifactRepository: { async findArtifactIdentity() {} },
      contentStore: {
        async stage(content) {
          for await (const _chunk of content) {
            // Consume the public one-pass stream.
          }
          const stageId = `stage-${nextStage++}`;
          remaining.add(stageId);
          return { stageId };
        },
        async discard(staged) {
          remaining.delete(staged.stageId);
        },
        async seal(staged, descriptor) {
          seals += 1;
          if (seals === 2) throw new Error('simulated seal failure');
          remaining.delete(staged.stageId);
          return { contentId: `cnt-${staged.stageId}`, ...descriptor };
        },
      },
      folderRepository: {
        async findFolderIdempotency() {},
        async commitFolderPublish(input) {
          commits += 1;
          return { status: 'committed' as const, result: input.result };
        },
      },
    });
    const bytes = (value: string) =>
      (async function* content() {
        yield new TextEncoder().encode(value);
      })();

    await expect(
      publish({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-agent',
        requestId: 'request-failure',
        idempotencyKey: 'folder-failure',
        publisherMetadata: {},
        manifest: {
          version: 'shelf-folder-manifest/v1',
          rootName: 'Project',
          entries: [
            { path: 'one.txt', kind: 'file', mediaType: 'text/plain' },
            { path: 'two.txt', kind: 'file', mediaType: 'text/plain' },
          ],
        },
        files: [bytes('one'), bytes('two')],
      }),
    ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
    expect(remaining).toEqual(new Set());
    expect(commits).toBe(0);
  });
});
