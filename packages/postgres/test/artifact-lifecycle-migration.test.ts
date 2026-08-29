import { randomBytes } from 'node:crypto';

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

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('artifact lifecycle migration', () => {
  it('backfills an existing artifact name before enforcing the new lifecycle schema', async () => {
    const databaseName = `shelf_migration_test_${randomBytes(8).toString('hex')}`;
    const targetUrl = new URL(adminConnectionString as string);
    targetUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
    try {
      const preLifecycle = new Migrator({
        db: database,
        provider: {
          async getMigrations() {
            return {
              '0001_initial': initialMigration,
              '0002_human_auth': humanAuthMigration,
              '0003_access_credentials': accessCredentialsMigration,
            };
          },
        },
      });
      const migrated = await preLifecycle.migrateToLatest();
      expect(migrated.error).toBeUndefined();

      await database.transaction().execute(async (transaction) => {
        await sql`
          insert into shelf_artifacts (
            artifact_id, installation_id, workspace_id, latest_revision_id
          ) values (
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'installation-main', 'workspace-main', null
          )
        `.execute(transaction);
        await sql`
          insert into shelf_revisions (
            revision_id, installation_id, workspace_id, artifact_id, revision_number,
            content_id, content_hash, byte_count, original_file_name, media_type,
            provenance_classification, actor_id, operation, publisher_metadata
          ) values (
            'rev_AAAAAAAAAAAAAAAAAAAAAA', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 1, 'cnt_0123456789abcdef0123456789abcdef',
            ${`sha256:${'a'.repeat(64)}`}, 11, 'README.md', 'text/markdown',
            'direct-publish', 'actor-agent', 'file.publish', '{}'::jsonb
          )
        `.execute(transaction);
        await sql`
          insert into shelf_revisions (
            revision_id, installation_id, workspace_id, artifact_id, revision_number,
            content_id, content_hash, byte_count, original_file_name, media_type,
            provenance_classification, actor_id, operation, publisher_metadata
          ) values (
            'rev_BBBBBBBBBBBBBBBBBBBBBB', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 2, 'cnt_abcdef0123456789abcdef0123456789',
            ${`sha256:${'b'.repeat(64)}`}, 13, 'LATEST.md', 'text/markdown',
            'direct-publish', 'actor-agent', 'file.publish', '{}'::jsonb
          )
        `.execute(transaction);
        await sql`
          update shelf_artifacts
          set latest_revision_id = 'rev_BBBBBBBBBBBBBBBBBBBBBB'
          where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
        `.execute(transaction);
      });

      await expect(migratePostgresToLatest(database)).resolves.toEqual([
        { migrationName: '0004_artifact_lifecycle', status: 'Success' },
        { migrationName: '0005_folder_snapshots', status: 'Success' },
        { migrationName: '0006_shares', status: 'Success' },
        { migrationName: '0007_artifact_deletion', status: 'Success' },
        { migrationName: '0008_workspaces', status: 'Success' },
        { migrationName: '0009_share_access_policies', status: 'Success' },
        { migrationName: '0010_permanent_public_shares', status: 'Success' },
        { migrationName: '0011_artifact_default_shares', status: 'Success' },
        { migrationName: '0012_comments', status: 'Success' },
        { migrationName: '0013_actor_display_names', status: 'Success' },
        { migrationName: '0014_workspace_deletion', status: 'Success' },
        { migrationName: '0015_artifact_retention', status: 'Success' },
        { migrationName: '0016_share_revision_access', status: 'Success' },
      ]);
      await expect(
        new PostgresRevisionRepository(database).findArtifact('art_AAAAAAAAAAAAAAAAAAAAAA'),
      ).resolves.toMatchObject({
        name: 'README.md',
        latestRevision: {
          revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
          provenance: { classification: 'direct-publish' },
        },
      });

      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-agent', 'installation-main', 'service', 'Agent', null, null,
          transaction_timestamp(), null
        )
      `.execute(database);
      await sql`set time zone 'America/New_York'`.execute(database);
      await expect(
        sql`
          update shelf_artifacts
          set deleted_at = '2026-03-01 12:00:00-05'::timestamptz,
              recoverable_until = '2026-03-31 13:00:00-04'::timestamptz,
              deleted_by_actor_id = 'actor-agent',
              deleted_share_count = 0,
              deletion_reason = 'manual',
              auto_trash_at = null
          where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
        `.execute(database),
      ).resolves.toBeDefined();
      await expect(
        sql`
          update shelf_artifacts
          set recoverable_until = '2026-03-31 12:00:00-04'::timestamptz
          where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
        `.execute(database),
      ).rejects.toThrow(/shelf_artifacts_deletion_state/u);
      await sql`
        update shelf_artifacts
        set deleted_at = null,
            recoverable_until = null,
            deleted_by_actor_id = null,
            deleted_share_count = null,
            deletion_reason = null
        where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
      `.execute(database);
      await expect(
        sql`
          update shelf_artifacts
          set deleted_at = '2026-03-01 12:00:00-05'::timestamptz
          where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
        `.execute(database),
      ).rejects.toThrow(/shelf_artifacts_deletion_state/u);
      await expect(
        sql`
          update shelf_artifacts
          set deleted_at = '2026-03-01 12:00:00-05'::timestamptz,
              recoverable_until = '2026-03-31 13:00:00-04'::timestamptz,
              deleted_by_actor_id = 'actor-agent',
              deleted_share_count = null,
              deletion_reason = 'manual',
              auto_trash_at = null
          where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
        `.execute(database),
      ).rejects.toThrow(/shelf_artifacts_deletion_state/u);
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
