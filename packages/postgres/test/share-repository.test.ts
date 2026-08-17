import { randomBytes } from 'node:crypto';

import type { CommitShareCreateInput, StoredPublish, StoredShare } from '@shelf/core';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresRevisionRepository,
  PostgresShareRepository,
} from '../src/index.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_share_repo_test_${randomBytes(8).toString('hex')}`;
const databaseUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (databaseUrl !== undefined) databaseUrl.pathname = `/${databaseName}`;
const connectionString = databaseUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

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

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  firstRevision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  secondRevision: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
  latestShare: 'shr_DDDDDDDDDDDDDDDDDDDDDD',
  pinnedShare: 'shr_EEEEEEEEEEEEEEEEEEEEEE',
};

function publish(revisionId: string, contentHashCharacter: string): StoredPublish {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId: ids.artifact,
    revisionId,
    content: {
      contentId: `cnt_${contentHashCharacter.repeat(32)}`,
      contentHash: `sha256:${contentHashCharacter.repeat(64)}`,
      byteCount: 11,
    },
    originalFileName: 'launch.md',
    mediaType: 'text/markdown',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-publisher', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'share-repository-test' },
  };
}

function share(shareId: string, target: StoredShare['target'] = { mode: 'latest' }): StoredShare {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    shareId,
    artifactId: ids.artifact,
    visibility: 'unlisted',
    target,
    createdByActorId: 'actor-publisher',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    revokedByActorId: null,
  };
}

function createInput(result: StoredShare, key: string): CommitShareCreateInput {
  const fingerprintCharacter = key === 'latest' ? 'a' : 'b';
  return {
    namespace: {
      installationId: result.installationId,
      workspaceId: result.workspaceId,
      actorId: result.createdByActorId,
      operation: 'share.create',
      key,
    },
    fingerprint: `share-create-request/v1:sha256:${fingerprintCharacter.repeat(64)}`,
    result,
  };
}

describePostgres('PostgresShareRepository', () => {
  it('linearizes create replay and conflict across connections without secret persistence', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    const secondDatabase = createPostgresDatabase({ connectionString });
    try {
      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-publisher', 'installation-main', 'service', 'publisher', null,
          null, '2026-08-17T11:00:00.000Z'::timestamptz, null
        )
      `.execute(firstDatabase);
      const revisions = new PostgresRevisionRepository(firstDatabase);
      const initial = publish(ids.firstRevision, '1');
      await revisions.commitPublish({
        namespace: {
          installationId: initial.installationId,
          workspaceId: initial.workspaceId,
          actorId: 'actor-publisher',
          operation: 'file.publish',
          key: 'share-test-first-revision',
        },
        fingerprint: `publish-request/v1:sha256:${'1'.repeat(64)}`,
        result: initial,
      });

      const first = new PostgresShareRepository(firstDatabase);
      const second = new PostgresShareRepository(secondDatabase);
      const input = createInput(share(ids.latestShare), 'latest');
      const [left, right] = await Promise.all([
        first.commitCreate(input),
        second.commitCreate(input),
      ]);

      expect([left.status, right.status].sort()).toEqual(['committed', 'replayed']);
      if (left.status === 'conflict' || right.status === 'conflict') {
        throw new Error('Identical concurrent share creation unexpectedly conflicted.');
      }
      expect(left.result).toEqual(right.result);
      await expect(
        second.commitCreate({
          ...input,
          fingerprint: `share-create-request/v1:sha256:${'f'.repeat(64)}`,
        }),
      ).resolves.toEqual({ status: 'conflict' });
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = 'public'
          and table_name in ('shelf_shares', 'shelf_share_idempotency')
      `.execute(firstDatabase);
      expect(columns.rows.map((row) => row.column_name).join(' ')).not.toMatch(
        /secret|token|capability|verifier/i,
      );
    } finally {
      await firstDatabase.destroy();
      await secondDatabase.destroy();
    }
  });

  it('keeps latest dynamic, pinned exact, pagination deterministic, and revocation idempotent', async () => {
    const database = createPostgresDatabase({ connectionString });
    try {
      const repository = new PostgresShareRepository(database);
      const pinned = share(ids.pinnedShare, {
        mode: 'pinned',
        revisionId: ids.firstRevision,
      });
      await expect(repository.commitCreate(createInput(pinned, 'pinned'))).resolves.toMatchObject({
        status: 'committed',
      });
      await expect(repository.resolveShareTarget(ids.latestShare)).resolves.toMatchObject({
        revision: { revision: { revisionId: ids.firstRevision } },
      });

      const revisions = new PostgresRevisionRepository(database);
      const next = publish(ids.secondRevision, '2');
      await revisions.commitPublish({
        namespace: {
          installationId: next.installationId,
          workspaceId: next.workspaceId,
          actorId: 'actor-publisher',
          operation: 'file.publish',
          key: 'share-test-second-revision',
        },
        fingerprint: `publish-request/v1:sha256:${'2'.repeat(64)}`,
        result: next,
      });

      await expect(repository.resolveShareTarget(ids.latestShare)).resolves.toMatchObject({
        revision: { revision: { revisionId: ids.secondRevision } },
      });
      await expect(repository.resolveShareTarget(ids.pinnedShare)).resolves.toMatchObject({
        revision: { revision: { revisionId: ids.firstRevision } },
      });

      const firstPage = await repository.listShares({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        limit: 1,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.items[0]?.shareId).toBe(ids.latestShare);
      expect(firstPage.next).toBeDefined();
      await expect(
        repository.listShares({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          limit: 1,
          after: firstPage.next,
        }),
      ).resolves.toMatchObject({ items: [{ shareId: ids.pinnedShare }] });

      const revokedAt = '2026-08-17T13:00:00.000Z';
      const [left, right] = await Promise.all([
        repository.revokeShare({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          shareId: ids.latestShare,
          revokedByActorId: 'actor-publisher',
          revokedAt,
        }),
        repository.revokeShare({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          shareId: ids.latestShare,
          revokedByActorId: 'actor-publisher',
          revokedAt,
        }),
      ]);
      expect([left.status, right.status].sort()).toEqual(['already-revoked', 'revoked']);
      if (left.status === 'not-found' || right.status === 'not-found') {
        throw new Error('Concurrent revocation unexpectedly lost the scoped share.');
      }
      expect(left.result).toEqual(right.result);
      expect(left.result).toMatchObject({
        revokedAt,
        revokedByActorId: 'actor-publisher',
      });
    } finally {
      await database.destroy();
    }
  });
});
