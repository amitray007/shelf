import { describe, expect, it, vi } from 'vitest';

import { createArtifactLifecycleService, createRestoreFingerprint } from '../src/index.js';

describe('artifact lifecycle service', () => {
  it('measures artifact-name limits in Unicode characters', async () => {
    const unicodeName = '📚'.repeat(255);
    const artifact = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      name: 'README.md',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      latestRevision: {
        revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
        revisionNumber: 1,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 12,
        createdAt: '2026-08-17T12:00:00.000Z',
        provenance: {
          classification: 'direct-publish' as const,
          observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
        },
        publisherMetadata: {},
      },
    };
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {
        async findArtifact() {
          return artifact;
        },
        async renameArtifact(request) {
          return { ...artifact, name: request.name };
        },
      },
    });

    await expect(
      lifecycle.renameArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
        name: unicodeName,
      }),
    ).resolves.toMatchObject({ name: unicodeName });
  });

  it('renames only mutable artifact presentation after publish authorization', async () => {
    const artifact = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      name: 'README.md',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      latestRevision: {
        revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
        revisionNumber: 1,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 12,
        createdAt: '2026-08-17T12:00:00.000Z',
        provenance: {
          classification: 'direct-publish' as const,
          observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
        },
        publisherMetadata: { source: 'test' },
      },
    };
    const authorization: unknown[] = [];
    const lifecycle = createArtifactLifecycleService({
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
      artifacts: {
        async findArtifact() {
          return artifact;
        },
        async renameArtifact(request) {
          return { ...artifact, name: request.name, updatedAt: '2026-08-17T12:01:00.000Z' };
        },
      },
    });

    const renamed = await lifecycle.renameArtifact({
      installationId: 'installation-main',
      actorId: 'actor-publisher',
      artifactId: artifact.artifactId,
      name: 'Project notes',
    });

    expect(renamed).toMatchObject({
      artifactId: artifact.artifactId,
      name: 'Project notes',
      latestRevision: {
        originalFileName: 'README.md',
        contentHash: artifact.latestRevision.contentHash,
      },
    });
    expect(authorization).toEqual([
      {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-publisher',
        action: 'file.publish',
      },
    ]);
  });

  it.each([
    ['missing', undefined],
    ['another installation', { installationId: 'installation-other' }],
  ])('rejects a %s artifact before rename mutation', async (_case, scopeOverride) => {
    const artifact = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      name: 'README.md',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:00:00.000Z',
      latestRevision: {
        revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
        revisionNumber: 1,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 12,
        createdAt: '2026-08-17T12:00:00.000Z',
        provenance: {
          classification: 'direct-publish' as const,
          observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
        },
        publisherMetadata: {},
      },
    };
    const renameArtifact = vi.fn();
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {
        async findArtifact() {
          if (scopeOverride === undefined) return undefined;
          return { ...artifact, ...scopeOverride };
        },
        renameArtifact,
      },
    });

    await expect(
      lifecycle.renameArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
        name: 'Project notes',
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    expect(renameArtifact).not.toHaveBeenCalled();
  });

  it('restores an immutable source as a new latest revision with explicit provenance', async () => {
    const artifact = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      name: 'Project notes',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:03:00.000Z',
      latestRevision: {
        revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
        revisionNumber: 3,
        originalFileName: 'version-three.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'c'.repeat(64)}`,
        byteCount: 13,
        createdAt: '2026-08-17T12:03:00.000Z',
        provenance: {
          classification: 'direct-publish' as const,
          observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
        },
        publisherMetadata: { version: 'three' },
      },
    };
    const source = {
      apiVersion: 'v1' as const,
      installationId: artifact.installationId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      content: {
        contentId: `sha256:${'a'.repeat(64)}`,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 11,
      },
      originalFileName: 'version-one.md',
      mediaType: 'text/markdown',
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
      },
      publisherMetadata: { version: 'one' },
    };
    const authorization: unknown[] = [];
    const lifecycle = createArtifactLifecycleService({
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
      artifacts: {
        async findArtifact() {
          return artifact;
        },
        async renameArtifact() {
          return artifact;
        },
        async findRevision() {
          return source;
        },
        async findRestoreIdempotency() {
          return undefined;
        },
        async commitRestore(input) {
          return { status: 'committed' as const, result: input.result, revisionNumber: 4 };
        },
      },
      generateId() {
        return 'rev_DDDDDDDDDDDDDDDDDDDDDD';
      },
    });

    const restored = await lifecycle.restoreArtifact({
      installationId: artifact.installationId,
      workspaceId: artifact.workspaceId,
      actorId: 'actor-restorer',
      artifactId: artifact.artifactId,
      sourceRevisionId: source.revisionId,
      idempotencyKey: 'restore-version-one',
      requestId: 'request-restore',
    });

    expect(restored).toEqual({
      apiVersion: 'v1',
      kind: 'file',
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      revisionId: 'rev_DDDDDDDDDDDDDDDDDDDDDD',
      revisionNumber: 4,
      sourceRevisionId: source.revisionId,
      contentHash: source.content.contentHash,
      byteCount: source.content.byteCount,
      fileCount: 1,
      provenance: {
        classification: 'restore',
        observed: { actorId: 'actor-restorer', operation: 'revision.restore' },
        source: { revisionId: source.revisionId },
      },
      requestId: 'request-restore',
      paths: {
        artifact: `/api/v1/artifacts/${artifact.artifactId}`,
        revision: '/api/v1/revisions/rev_DDDDDDDDDDDDDDDDDDDDDD',
        content: '/api/v1/revisions/rev_DDDDDDDDDDDDDDDDDDDDDD/content',
      },
      replayed: false,
    });
    expect(authorization.map((request) => (request as { action: string }).action)).toEqual([
      'file.publish',
      'revision.read',
    ]);
  });

  it.each([
    ['missing', undefined],
    ['another workspace', { workspaceId: 'workspace-other' }],
    ['another installation', { installationId: 'installation-other' }],
    ['another artifact', { artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB' }],
  ])('rejects a source revision from %s before metadata commit', async (_case, scopeOverride) => {
    const artifact = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      name: 'Project notes',
      createdAt: '2026-08-17T12:00:00.000Z',
      updatedAt: '2026-08-17T12:03:00.000Z',
      latestRevision: {
        revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
        revisionNumber: 3,
        originalFileName: 'version-three.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'c'.repeat(64)}`,
        byteCount: 13,
        createdAt: '2026-08-17T12:03:00.000Z',
        provenance: {
          classification: 'direct-publish' as const,
          observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
        },
        publisherMetadata: {},
      },
    };
    const source = {
      apiVersion: 'v1' as const,
      installationId: artifact.installationId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      content: {
        contentId: `sha256:${'a'.repeat(64)}`,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 11,
      },
      originalFileName: 'version-one.md',
      mediaType: 'text/markdown',
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
      },
      publisherMetadata: {},
    };
    const commitRestore = vi.fn();
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {
        async findArtifact() {
          return artifact;
        },
        async findRevision() {
          if (scopeOverride === undefined) return undefined;
          return { ...source, ...scopeOverride };
        },
        async findRestoreIdempotency() {
          return undefined;
        },
        commitRestore,
      },
    });

    await expect(
      lifecycle.restoreArtifact({
        installationId: artifact.installationId,
        workspaceId: artifact.workspaceId,
        actorId: 'actor-restorer',
        artifactId: artifact.artifactId,
        sourceRevisionId: source.revisionId,
        idempotencyKey: 'restore-version-one',
        requestId: 'request-restore',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    expect(commitRestore).not.toHaveBeenCalled();
  });

  it('conflicts when one restore key is reused for another source or target', async () => {
    const artifacts = new Map([
      [
        'art_AAAAAAAAAAAAAAAAAAAAAA',
        {
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
          name: 'Artifact A',
          createdAt: '2026-08-17T12:00:00.000Z',
          updatedAt: '2026-08-17T12:00:00.000Z',
          latestRevision: {
            revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
            revisionNumber: 2,
            originalFileName: 'a-two.md',
            mediaType: 'text/markdown',
            contentHash: `sha256:${'c'.repeat(64)}`,
            byteCount: 12,
            createdAt: '2026-08-17T12:00:00.000Z',
            provenance: {
              classification: 'direct-publish' as const,
              observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
            },
            publisherMetadata: {},
          },
        },
      ],
      [
        'art_BBBBBBBBBBBBBBBBBBBBBB',
        {
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
          name: 'Artifact B',
          createdAt: '2026-08-17T12:00:00.000Z',
          updatedAt: '2026-08-17T12:00:00.000Z',
          latestRevision: {
            revisionId: 'rev_DDDDDDDDDDDDDDDDDDDDDD',
            revisionNumber: 1,
            originalFileName: 'b-one.md',
            mediaType: 'text/markdown',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 13,
            createdAt: '2026-08-17T12:00:00.000Z',
            provenance: {
              classification: 'direct-publish' as const,
              observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
            },
            publisherMetadata: {},
          },
        },
      ],
    ]);
    const revisions = new Map(
      [
        ['rev_AAAAAAAAAAAAAAAAAAAAAA', 'art_AAAAAAAAAAAAAAAAAAAAAA'],
        ['rev_BBBBBBBBBBBBBBBBBBBBBB', 'art_AAAAAAAAAAAAAAAAAAAAAA'],
        ['rev_DDDDDDDDDDDDDDDDDDDDDD', 'art_BBBBBBBBBBBBBBBBBBBBBB'],
      ].map(([revisionId, artifactId]) => [
        revisionId,
        {
          apiVersion: 'v1' as const,
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId,
          revisionId,
          content: {
            contentId: `sha256:${'a'.repeat(64)}`,
            contentHash: `sha256:${'a'.repeat(64)}`,
            byteCount: 11,
          },
          originalFileName: 'source.md',
          mediaType: 'text/markdown',
          provenance: {
            classification: 'direct-publish' as const,
            observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
          },
          publisherMetadata: {},
        },
      ]),
    );
    const replayedSource = revisions.get('rev_AAAAAAAAAAAAAAAAAAAAAA');
    if (replayedSource === undefined) throw new Error('missing restore replay fixture');
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {
        async findArtifact(artifactId) {
          return artifacts.get(artifactId);
        },
        async findRevision(revisionId) {
          return revisions.get(revisionId);
        },
        async findRestoreIdempotency() {
          return {
            fingerprint: createRestoreFingerprint({
              artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
              sourceRevisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
            }),
            result: {
              ...replayedSource,
              revisionId: 'rev_EEEEEEEEEEEEEEEEEEEEEE',
              provenance: {
                classification: 'restore' as const,
                observed: { actorId: 'actor-restorer', operation: 'revision.restore' as const },
                source: { revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA' },
              },
            },
            revisionNumber: 3,
          };
        },
        async commitRestore() {
          throw new Error('must not commit an idempotency conflict');
        },
      },
    });
    const base = {
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-restorer',
      idempotencyKey: 'restore-once',
      requestId: 'request-restore',
    };

    await expect(
      lifecycle.restoreArtifact({
        ...base,
        artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
        sourceRevisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).resolves.toMatchObject({ replayed: true, revisionId: 'rev_EEEEEEEEEEEEEEEEEEEEEE' });

    for (const changed of [
      {
        artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
        sourceRevisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
      },
      {
        artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
        sourceRevisionId: 'rev_DDDDDDDDDDDDDDDDDDDDDD',
      },
    ]) {
      await expect(lifecycle.restoreArtifact({ ...base, ...changed })).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
  });
});

describe('recoverable artifact deletion', () => {
  const artifact = {
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
    kind: 'file' as const,
    name: 'README.md',
    createdAt: '2026-08-17T12:00:00.000Z',
    updatedAt: '2026-08-17T12:00:00.000Z',
    latestRevision: {
      kind: 'file' as const,
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      revisionNumber: 1,
      originalFileName: 'README.md',
      mediaType: 'text/markdown',
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 12,
      createdAt: '2026-08-17T12:00:00.000Z',
      provenance: {
        classification: 'direct-publish' as const,
        observed: { actorId: 'actor-publisher', operation: 'file.publish' as const },
      },
      publisherMetadata: {},
    },
  };

  it('soft-deletes for exactly 30 days and revokes shares after publish authorization', async () => {
    const authorization: unknown[] = [];
    const deleteArtifact = vi.fn(async (request) => ({
      status: 'deleted' as const,
      deletedAt: request.deletedAt,
      recoverableUntil: request.recoverableUntil,
      revokedShareCount: 2,
    }));
    const lifecycle = createArtifactLifecycleService({
      authorizer: {
        async authorize(request) {
          authorization.push(request);
        },
      },
      artifacts: {},
      deletions: {
        async findArtifactForDeletion() {
          return { artifact, deletedAt: null, recoverableUntil: null };
        },
        deleteArtifact,
        async recoverArtifact() {
          return { status: 'not-found' as const };
        },
      },
      clock: () => new Date('2026-08-18T12:00:00.000Z'),
    });

    await expect(
      lifecycle.deleteArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
      }),
    ).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
      revokedShareCount: 2,
    });
    expect(deleteArtifact).toHaveBeenCalledWith({
      installationId: artifact.installationId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      actorId: 'actor-publisher',
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
    });
    expect(authorization).toEqual([
      {
        installationId: artifact.installationId,
        workspaceId: artifact.workspaceId,
        actorId: 'actor-publisher',
        action: 'file.publish',
      },
    ]);
  });

  it('returns the original deletion window when deletion is replayed', async () => {
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {},
      deletions: {
        async findArtifactForDeletion() {
          return {
            artifact,
            deletedAt: '2026-08-18T12:00:00.000Z',
            recoverableUntil: '2026-09-17T12:00:00.000Z',
          };
        },
        async deleteArtifact() {
          return {
            status: 'already-deleted' as const,
            deletedAt: '2026-08-18T12:00:00.000Z',
            recoverableUntil: '2026-09-17T12:00:00.000Z',
            revokedShareCount: 3,
          };
        },
        async recoverArtifact() {
          return { status: 'not-found' as const };
        },
      },
      clock: () => new Date('2026-08-20T12:00:00.000Z'),
    });

    await expect(
      lifecycle.deleteArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
      }),
    ).resolves.toMatchObject({
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
      revokedShareCount: 3,
    });
  });

  it('recovers catalog visibility during the window without restoring shares', async () => {
    const recoverArtifact = vi.fn(async () => ({ status: 'recovered' as const, artifact }));
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {},
      deletions: {
        async findArtifactForDeletion() {
          return {
            artifact,
            deletedAt: '2026-08-18T12:00:00.000Z',
            recoverableUntil: '2026-09-17T12:00:00.000Z',
          };
        },
        async deleteArtifact() {
          return { status: 'not-found' as const };
        },
        recoverArtifact,
      },
      clock: () => new Date('2026-08-19T12:00:00.000Z'),
    });

    await expect(
      lifecycle.recoverArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
        idempotencyKey: 'recover-readme',
      }),
    ).resolves.toMatchObject({ artifactId: artifact.artifactId, name: artifact.name });
    expect(recoverArtifact).toHaveBeenCalledWith({
      namespace: {
        installationId: artifact.installationId,
        workspaceId: artifact.workspaceId,
        actorId: 'actor-publisher',
        operation: 'artifact.recover',
        key: 'recover-readme',
      },
      fingerprint: expect.stringMatching(/^artifact-recovery-request\/v1:sha256:[a-f0-9]{64}$/u),
      artifactId: artifact.artifactId,
      recoveredAt: '2026-08-19T12:00:00.000Z',
    });
  });

  it('replays recovery by semantic key and rejects reuse for another artifact', async () => {
    const recoverArtifact = vi
      .fn()
      .mockResolvedValueOnce({ status: 'recovered' as const, artifact })
      .mockResolvedValueOnce({ status: 'replayed' as const, artifact })
      .mockResolvedValueOnce({ status: 'conflict' as const });
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {},
      deletions: {
        async findArtifactForDeletion(requestedArtifactId) {
          return {
            artifact: { ...artifact, artifactId: requestedArtifactId },
            deletedAt: '2026-08-18T12:00:00.000Z',
            recoverableUntil: '2026-09-17T12:00:00.000Z',
          };
        },
        async deleteArtifact() {
          return { status: 'not-found' as const };
        },
        recoverArtifact,
      },
      clock: () => new Date('2026-08-19T12:00:00.000Z'),
    });
    const request = {
      installationId: artifact.installationId,
      actorId: 'actor-publisher',
      artifactId: artifact.artifactId,
      idempotencyKey: 'recover-once',
    };

    await expect(lifecycle.recoverArtifact(request)).resolves.toMatchObject({
      artifactId: artifact.artifactId,
    });
    await expect(lifecycle.recoverArtifact(request)).resolves.toMatchObject({
      artifactId: artifact.artifactId,
    });
    await expect(
      lifecycle.recoverArtifact({
        ...request,
        artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('returns a stable expired error without recovery mutation', async () => {
    const recoverArtifact = vi.fn(async () => ({ status: 'expired' as const }));
    const lifecycle = createArtifactLifecycleService({
      authorizer: { async authorize() {} },
      artifacts: {},
      deletions: {
        async findArtifactForDeletion() {
          return {
            artifact,
            deletedAt: '2026-08-18T12:00:00.000Z',
            recoverableUntil: '2026-09-17T12:00:00.000Z',
          };
        },
        async deleteArtifact() {
          return { status: 'not-found' as const };
        },
        recoverArtifact,
      },
      clock: () => new Date('2026-09-17T12:00:00.000Z'),
    });

    await expect(
      lifecycle.recoverArtifact({
        installationId: artifact.installationId,
        actorId: 'actor-publisher',
        artifactId: artifact.artifactId,
        idempotencyKey: 'recover-expired',
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_RECOVERY_EXPIRED' });
    expect(recoverArtifact).toHaveBeenCalledTimes(1);
  });
});
