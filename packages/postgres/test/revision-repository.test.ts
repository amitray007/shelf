import { randomBytes } from 'node:crypto';

import type {
  CommitFolderPublishInput,
  CommitPublishInput,
  CommitRestoreInput,
  StoredFolderPublish,
  StoredPublish,
  StoredRestore,
} from '@shelf/core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresInstallationInventory,
  PostgresReferencedContentInventory,
  PostgresRevisionRepository,
} from '../src/index.js';

const databaseName = `shelf_test_${randomBytes(8).toString('hex')}`;
const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const database = createPostgresDatabase({ connectionString });
  await migratePostgresToLatest(database);
  await database.destroy();
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

function stored(
  revisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA',
  artifactId = 'art_AAAAAAAAAAAAAAAAAAAAAA',
): StoredPublish {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId,
    revisionId,
    content: {
      contentId: 'cnt_0123456789abcdef0123456789abcdef',
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 11,
    },
    originalFileName: 'README.md',
    mediaType: 'text/markdown',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-agent', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'test' },
  };
}

function commitInput(
  result = stored(),
  key = 'publish-readme',
  fingerprint = `publish-request/v1:sha256:${'b'.repeat(64)}`,
): CommitPublishInput {
  return {
    namespace: {
      installationId: result.installationId,
      workspaceId: result.workspaceId,
      actorId: result.provenance.observed.actorId,
      operation: 'file.publish',
      key,
    },
    fingerprint,
    result,
  };
}

function restoreInput(
  source: StoredPublish,
  revisionId = 'rev_restore_DDDDDDDDDDDDDDD',
  key = 'restore-version-one',
  fingerprint = `restore-request/v1:sha256:${'f'.repeat(64)}`,
): CommitRestoreInput {
  const result: StoredRestore = {
    ...source,
    revisionId,
    provenance: {
      classification: 'restore',
      observed: { actorId: 'actor-restorer', operation: 'revision.restore' },
      source: { revisionId: source.revisionId },
    },
  };
  return {
    namespace: {
      installationId: source.installationId,
      workspaceId: source.workspaceId,
      actorId: 'actor-restorer',
      operation: 'revision.restore',
      key,
    },
    fingerprint,
    result,
  };
}

function folderInput(): CommitFolderPublishInput {
  const result: StoredFolderPublish = {
    apiVersion: 'v1',
    kind: 'folder',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId: 'art_folder_AAAAAAAAAAAAAAAA',
    revisionId: 'rev_folder_AAAAAAAAAAAAAAAA',
    manifest: {
      contentId: 'cnt_folder_manifest_aaaaaaaaaaaaaa',
      contentHash: `sha256:${'c'.repeat(64)}`,
      byteCount: 181,
    },
    rootName: 'Project',
    totalByteCount: 7,
    fileCount: 1,
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-agent', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'test' },
  };
  return {
    namespace: {
      installationId: result.installationId,
      workspaceId: result.workspaceId,
      actorId: 'actor-agent',
      operation: 'file.publish',
      key: 'publish-folder',
    },
    fingerprint: `folder-publish-request/v1:sha256:${'d'.repeat(64)}`,
    result,
    entries: [
      { path: 'docs', kind: 'directory' },
      {
        path: 'docs/README.md',
        kind: 'file',
        mediaType: 'text/markdown',
        content: {
          contentId: 'cnt_folder_readme_aaaaaaaaaaaaaa',
          contentHash: `sha256:${'e'.repeat(64)}`,
          byteCount: 7,
        },
      },
      { path: 'empty', kind: 'directory' },
    ],
  };
}

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('PostgresRevisionRepository', () => {
  it('commits and pages one complete folder entry set atomically', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const input = folderInput();

    await expect(repository.commitFolderPublish(input)).resolves.toEqual({
      status: 'committed',
      result: input.result,
    });
    await expect(repository.commitFolderPublish(input)).resolves.toEqual({
      status: 'replayed',
      result: input.result,
    });
    await expect(repository.findArtifact(input.result.artifactId)).resolves.toMatchObject({
      kind: 'folder',
      name: 'Project',
      latestRevision: {
        kind: 'folder',
        rootName: 'Project',
        contentHash: input.result.manifest.contentHash,
        byteCount: 7,
        fileCount: 1,
      },
    });
    await expect(repository.findFolderRevision(input.result.revisionId)).resolves.toEqual(
      input.result,
    );
    await expect(
      repository.listFolderEntries({
        installationId: input.result.installationId,
        revisionId: input.result.revisionId,
        limit: 2,
      }),
    ).resolves.toEqual({
      items: input.entries.slice(0, 2),
      nextPath: 'docs/README.md',
    });
    await expect(
      repository.listFolderEntries({
        installationId: input.result.installationId,
        revisionId: input.result.revisionId,
        limit: 2,
        afterPath: 'docs/README.md',
      }),
    ).resolves.toEqual({ items: [input.entries[2]] });
    await expect(
      new PostgresReferencedContentInventory(database).listReferencedContent(
        input.result.installationId,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          contentId: input.result.manifest.contentId,
          contentHash: input.result.manifest.contentHash,
          byteCount: input.result.manifest.byteCount,
          revisionCount: 1,
        },
        {
          contentId: 'cnt_folder_readme_aaaaaaaaaaaaaa',
          contentHash: `sha256:${'e'.repeat(64)}`,
          byteCount: 7,
          revisionCount: 1,
        },
      ]),
    );
    const restore: CommitRestoreInput = {
      namespace: {
        installationId: input.result.installationId,
        workspaceId: input.result.workspaceId,
        actorId: 'actor-restorer',
        operation: 'revision.restore',
        key: 'restore-folder',
      },
      fingerprint: `restore-request/v1:sha256:${'9'.repeat(64)}`,
      result: {
        ...input.result,
        revisionId: 'rev_folder_BBBBBBBBBBBBBBBB',
        provenance: {
          classification: 'restore',
          observed: { actorId: 'actor-restorer', operation: 'revision.restore' },
          source: { revisionId: input.result.revisionId },
        },
      },
    };
    await expect(repository.commitRestore(restore)).resolves.toMatchObject({
      status: 'committed',
      revisionNumber: 2,
      result: { kind: 'folder', revisionId: restore.result.revisionId },
    });
    await expect(repository.findFolderRevision(restore.result.revisionId)).resolves.toMatchObject({
      kind: 'folder',
      provenance: {
        classification: 'restore',
        source: { revisionId: input.result.revisionId },
      },
    });
    await expect(
      repository.listFolderEntries({
        installationId: input.result.installationId,
        revisionId: restore.result.revisionId,
        limit: 10,
      }),
    ).resolves.toEqual({ items: input.entries });
    await database.destroy();
  });

  it('migrates, commits atomically, and preserves replay state across repository instances', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    await migratePostgresToLatest(firstDatabase);
    const first = new PostgresRevisionRepository(firstDatabase);
    const input = commitInput();

    await expect(first.commitPublish(input)).resolves.toEqual({
      status: 'committed',
      result: input.result,
    });
    await firstDatabase.destroy();

    const restartedDatabase = createPostgresDatabase({ connectionString });
    await expect(migratePostgresToLatest(restartedDatabase)).resolves.toEqual([]);
    const restarted = new PostgresRevisionRepository(restartedDatabase);
    await expect(restarted.findIdempotency(input.namespace)).resolves.toEqual({
      fingerprint: input.fingerprint,
      result: input.result,
    });
    await expect(restarted.findRevision(input.result.revisionId)).resolves.toEqual(input.result);
    await restartedDatabase.destroy();
  });

  it('linearizes concurrent identical claims and rejects conflicting reuse', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const contenders = Array.from({ length: 8 }, (_, index) =>
      commitInput(
        stored(
          `rev_concurrent_${String(index).padStart(3, '0')}`,
          `art_concurrent_${String(index).padStart(3, '0')}`,
        ),
        'concurrent-publish',
        `publish-request/v1:sha256:${'c'.repeat(64)}`,
      ),
    );

    const outcomes = await Promise.all(contenders.map((input) => repository.commitPublish(input)));
    const revisionIds = outcomes
      .filter((outcome) => outcome.status !== 'conflict')
      .map((outcome) => outcome.result.revisionId);

    expect(outcomes.filter((outcome) => outcome.status === 'committed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'replayed')).toHaveLength(7);
    expect(new Set(revisionIds)).toHaveLength(1);
    await expect(
      repository.commitPublish(
        commitInput(
          stored('rev_conflicting_request', 'art_conflicting_request'),
          'concurrent-publish',
          `publish-request/v1:sha256:${'d'.repeat(64)}`,
        ),
      ),
    ).resolves.toEqual({ status: 'conflict' });
    await database.destroy();
  });

  it('linearizes concurrent revisions to one artifact and exposes ordered history', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const artifactId = 'art_versioned_AAAAAAAAAAAAA';
    const first = stored('rev_versioned_000000000000001', artifactId);
    await repository.commitPublish(commitInput(first, 'versioned-create'));

    const updates = Array.from({ length: 8 }, (_, index) =>
      stored(`rev_versioned_${String(index + 2).padStart(15, '0')}`, artifactId),
    );
    const outcomes = await Promise.all(
      updates.map((revision, index) =>
        repository.commitPublish(commitInput(revision, `versioned-update-${index}`)),
      ),
    );

    expect(outcomes.every((outcome) => outcome.status === 'committed')).toBe(true);
    await expect(repository.findArtifact(artifactId)).resolves.toMatchObject({
      artifactId,
      latestRevision: { revisionNumber: 9 },
    });
    await expect(
      repository.listArtifactRevisions({
        installationId: first.installationId,
        artifactId,
        limit: 20,
      }),
    ).resolves.toMatchObject({
      items: [
        { revisionNumber: 9 },
        { revisionNumber: 8 },
        { revisionNumber: 7 },
        { revisionNumber: 6 },
        { revisionNumber: 5 },
        { revisionNumber: 4 },
        { revisionNumber: 3 },
        { revisionNumber: 2 },
        { revisionNumber: 1 },
      ],
    });
    await database.destroy();
  });

  it('initializes and renames artifact presentation without changing its revision', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const first = stored('rev_rename_AAAAAAAAAAAAAAAA', 'art_rename_AAAAAAAAAAAAAAAA');
    await repository.commitPublish(commitInput(first, 'rename-create'));

    await expect(repository.findArtifact(first.artifactId)).resolves.toMatchObject({
      artifactId: first.artifactId,
      name: 'README.md',
      latestRevision: { revisionId: first.revisionId, originalFileName: 'README.md' },
    });
    await expect(
      repository.renameArtifact({
        installationId: first.installationId,
        workspaceId: first.workspaceId,
        artifactId: first.artifactId,
        name: 'Project notes',
      }),
    ).resolves.toMatchObject({
      artifactId: first.artifactId,
      name: 'Project notes',
      latestRevision: { revisionId: first.revisionId, originalFileName: 'README.md' },
    });
    await expect(repository.findRevision(first.revisionId)).resolves.toEqual(first);
    await database.destroy();
  });

  it('restores source metadata as a new latest revision and durably replays it', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const artifactId = 'art_restore_AAAAAAAAAAAAAA';
    const first = {
      ...stored('rev_restore_AAAAAAAAAAAAAA', artifactId),
      content: {
        contentId: 'cnt_restore_aaaaaaaaaaaaaaaaaaaaa',
        contentHash: `sha256:${'1'.repeat(64)}`,
        byteCount: 11,
      },
      originalFileName: 'version-one.md',
      publisherMetadata: { version: 'one' },
    };
    await repository.commitPublish(commitInput(first, 'restore-create'));
    await repository.commitPublish(
      commitInput(
        { ...stored('rev_restore_BBBBBBBBBBBBBB', artifactId), originalFileName: 'version-two.md' },
        'restore-update-two',
      ),
    );
    await repository.commitPublish(
      commitInput(
        {
          ...stored('rev_restore_CCCCCCCCCCCCCC', artifactId),
          originalFileName: 'version-three.md',
        },
        'restore-update-three',
      ),
    );
    const input = restoreInput(first);

    await expect(repository.commitRestore(input)).resolves.toMatchObject({
      status: 'committed',
      revisionNumber: 4,
      result: {
        revisionId: input.result.revisionId,
        content: first.content,
        originalFileName: first.originalFileName,
        publisherMetadata: first.publisherMetadata,
        provenance: {
          classification: 'restore',
          source: { revisionId: first.revisionId },
        },
      },
    });
    await expect(repository.commitRestore(input)).resolves.toMatchObject({
      status: 'replayed',
      revisionNumber: 4,
      result: { revisionId: input.result.revisionId },
    });
    await expect(
      repository.commitRestore({
        ...input,
        fingerprint: `restore-request/v1:sha256:${'e'.repeat(64)}`,
      }),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(repository.findArtifact(artifactId)).resolves.toMatchObject({
      name: 'version-one.md',
      latestRevision: {
        revisionId: input.result.revisionId,
        revisionNumber: 4,
        provenance: { classification: 'restore', source: { revisionId: first.revisionId } },
      },
    });
    await expect(
      repository.listArtifactRevisions({
        installationId: first.installationId,
        artifactId,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      items: [
        { revisionNumber: 4, revisionId: input.result.revisionId },
        { revisionNumber: 3 },
        { revisionNumber: 2 },
        { revisionNumber: 1, revisionId: first.revisionId },
      ],
    });
    await database.destroy();
  });

  it('linearizes concurrent publish and restore revisions to one artifact', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const artifactId = 'art_mixed_AAAAAAAAAAAAAAAAA';
    const source = stored('rev_mixed_AAAAAAAAAAAAAAAAA', artifactId);
    await repository.commitPublish(commitInput(source, 'mixed-create'));
    const published = stored('rev_mixed_BBBBBBBBBBBBBBBBB', artifactId);
    const restored = restoreInput(
      source,
      'rev_mixed_CCCCCCCCCCCCCCCCC',
      'mixed-restore',
      `restore-request/v1:sha256:${'3'.repeat(64)}`,
    );

    const outcomes = await Promise.all([
      repository.commitPublish(
        commitInput(published, 'mixed-publish', `publish-request/v1:sha256:${'4'.repeat(64)}`),
      ),
      repository.commitRestore(restored),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'committed')).toBe(true);
    const history = await repository.listArtifactRevisions({
      installationId: source.installationId,
      artifactId,
      limit: 10,
    });
    expect(history.items.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    expect(new Set(history.items.map((revision) => revision.revisionId))).toEqual(
      new Set([source.revisionId, published.revisionId, restored.result.revisionId]),
    );
    await expect(repository.findArtifact(artifactId)).resolves.toMatchObject({
      latestRevision: { revisionNumber: 3 },
    });
    await database.destroy();
  });

  it('rolls back an idempotency claim when revision insertion fails', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const duplicateRevision = stored('rev_AAAAAAAAAAAAAAAAAAAAAA', 'art_rollback_BBBBBBBBBBBBBB');
    const input = commitInput(
      duplicateRevision,
      'rollback-claim',
      `publish-request/v1:sha256:${'e'.repeat(64)}`,
    );

    await expect(repository.commitPublish(input)).rejects.toThrow();
    await expect(repository.findIdempotency(input.namespace)).resolves.toBeUndefined();
    await database.destroy();
  });

  it('inventories unique referenced content within one installation', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const inventory = new PostgresReferencedContentInventory(database);
    const shared = {
      contentId: 'cnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentHash: `sha256:${'f'.repeat(64)}`,
      byteCount: 42,
    };
    const first = {
      ...stored('rev_inventory_AAAAAAAAAAAAA', 'art_inventory_AAAAAAAAAAAAA'),
      installationId: 'installation-inventory',
      content: shared,
    };
    const second = {
      ...stored('rev_inventory_BBBBBBBBBBBBB', 'art_inventory_BBBBBBBBBBBBB'),
      installationId: 'installation-inventory',
      content: shared,
    };
    const other = {
      ...stored('rev_inventory_CCCCCCCCCCCCC', 'art_inventory_CCCCCCCCCCCCC'),
      installationId: 'installation-other',
      content: {
        contentId: 'cnt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        contentHash: `sha256:${'e'.repeat(64)}`,
        byteCount: 9,
      },
    };
    await repository.commitPublish(commitInput(first, 'inventory-first'));
    await repository.commitPublish(commitInput(second, 'inventory-second'));
    await repository.commitPublish(commitInput(other, 'inventory-other'));

    await expect(inventory.listReferencedContent('installation-inventory')).resolves.toEqual([
      { ...shared, revisionCount: 2 },
    ]);
    await database.destroy();
  });

  it('fails inventory when one content identity has conflicting descriptors', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const inventory = new PostgresReferencedContentInventory(database);
    const contentId = 'cnt_cccccccccccccccccccccccccccccccc';
    const first = {
      ...stored('rev_inventory_conflict_AAA', 'art_inventory_conflict_AAA'),
      installationId: 'installation-inventory-conflict',
      content: { contentId, contentHash: `sha256:${'1'.repeat(64)}`, byteCount: 10 },
    };
    const second = {
      ...stored('rev_inventory_conflict_BBB', 'art_inventory_conflict_BBB'),
      installationId: 'installation-inventory-conflict',
      content: { contentId, contentHash: `sha256:${'2'.repeat(64)}`, byteCount: 11 },
    };
    await repository.commitPublish(commitInput(first, 'inventory-conflict-first'));
    await repository.commitPublish(commitInput(second, 'inventory-conflict-second'));

    await expect(
      inventory.listReferencedContent('installation-inventory-conflict'),
    ).rejects.toThrow('conflicting descriptors');
    await database.destroy();
  });

  it('lists every installation represented in Shelf-owned metadata', async () => {
    const database = createPostgresDatabase({ connectionString });
    const installationIds = await new PostgresInstallationInventory(database).listInstallationIds();

    expect(installationIds).toEqual([...installationIds].sort());
    expect(installationIds).toEqual(
      expect.arrayContaining(['installation-main', 'installation-inventory', 'installation-other']),
    );
    await database.destroy();
  });
});
