import { randomBytes } from 'node:crypto';

import type { StoredPublish } from '@shelf/core';
import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresRevisionRepository,
} from '../src/index.js';
import { initialMigration } from '../src/migrations/0001_initial.js';
import { humanAuthMigration } from '../src/migrations/0002_human_auth.js';
import { accessCredentialsMigration } from '../src/migrations/0003_access_credentials.js';
import { artifactLifecycleMigration } from '../src/migrations/0004_artifact_lifecycle.js';
import { folderSnapshotsMigration } from '../src/migrations/0005_folder_snapshots.js';
import { sharesMigration } from '../src/migrations/0006_shares.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

function publish(artifactId: string, revisionId: string, character: string): StoredPublish {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId,
    revisionId,
    content: {
      contentId: `cnt_${character.repeat(32)}`,
      contentHash: `sha256:${character.repeat(64)}`,
      byteCount: 7,
    },
    originalFileName: `${character}.md`,
    mediaType: 'text/markdown',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-publisher', operation: 'file.publish' },
    },
    publisherMetadata: {},
  };
}

describePostgres('shares migration', () => {
  it('adds scoped share constraints and refuses a lossy rollback', async () => {
    const databaseName = `shelf_share_migration_${randomBytes(8).toString('hex')}`;
    const targetUrl = new URL(adminConnectionString as string);
    targetUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
    try {
      const preShares = new Migrator({
        db: database,
        provider: {
          async getMigrations() {
            return {
              '0001_initial': initialMigration,
              '0002_human_auth': humanAuthMigration,
              '0003_access_credentials': accessCredentialsMigration,
              '0004_artifact_lifecycle': artifactLifecycleMigration,
              '0005_folder_snapshots': folderSnapshotsMigration,
            };
          },
        },
      });
      const migrated = await preShares.migrateToLatest();
      expect(migrated.error).toBeUndefined();

      await expect(migratePostgresToLatest(database)).resolves.toEqual([
        { migrationName: '0006_shares', status: 'Success' },
      ]);
      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-publisher', 'installation-main', 'service', 'publisher', null,
          null, '2026-08-17T11:00:00.000Z'::timestamptz, null
        )
      `.execute(database);
      const revisions = new PostgresRevisionRepository(database);
      for (const [artifactId, revisionId, character] of [
        ['art_AAAAAAAAAAAAAAAAAAAAAA', 'rev_AAAAAAAAAAAAAAAAAAAAAA', 'a'],
        ['art_BBBBBBBBBBBBBBBBBBBBBB', 'rev_BBBBBBBBBBBBBBBBBBBBBB', 'b'],
      ] as const) {
        const result = publish(artifactId, revisionId, character);
        await revisions.commitPublish({
          namespace: {
            installationId: result.installationId,
            workspaceId: result.workspaceId,
            actorId: 'actor-publisher',
            operation: 'file.publish',
            key: `publish-${character}`,
          },
          fingerprint: `publish-request/v1:sha256:${character.repeat(64)}`,
          result,
        });
      }

      await expect(
        sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            target_mode, target_revision_id, created_by_actor_id, created_at,
            expires_at, revoked_at, revoked_by_actor_id
          ) values (
            'shr_CCCCCCCCCCCCCCCCCCCCCC', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'pinned',
            'rev_BBBBBBBBBBBBBBBBBBBBBB', 'actor-publisher',
            '2026-08-17T12:00:00.000Z'::timestamptz, null, null, null
          )
        `.execute(database),
      ).rejects.toMatchObject({ code: '23503' });

      await sql`
        insert into shelf_shares (
          share_id, installation_id, workspace_id, artifact_id, visibility,
          target_mode, target_revision_id, created_by_actor_id, created_at,
          expires_at, revoked_at, revoked_by_actor_id
        ) values (
          'shr_DDDDDDDDDDDDDDDDDDDDDD', 'installation-main', 'workspace-main',
          'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'latest', null,
          'actor-publisher', '2026-08-17T12:00:00.000Z'::timestamptz,
          null, null, null
        )
      `.execute(database);
      await expect(sharesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove shares migration while shares exist.',
      );

      await sql`delete from shelf_shares`.execute(database);
      await sharesMigration.down?.(database);
      const tables = await sql<{ shares: string | null; idempotency: string | null }>`
        select
          to_regclass('public.shelf_shares')::text as shares,
          to_regclass('public.shelf_share_idempotency')::text as idempotency
      `.execute(database);
      expect(tables.rows).toEqual([{ shares: null, idempotency: null }]);
    } finally {
      await database.destroy();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      } finally {
        await admin.end();
      }
    }
  });
});
