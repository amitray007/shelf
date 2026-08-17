import { randomBytes } from 'node:crypto';

import type { CommitPublishInput, StoredPublish } from '@shelf/core';
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

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('PostgresRevisionRepository', () => {
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
