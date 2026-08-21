import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createPostgresDatabase, migratePostgresToLatest } from '../src/index.js';
import { initialMigration } from '../src/migrations/0001_initial.js';
import { humanAuthMigration } from '../src/migrations/0002_human_auth.js';
import { accessCredentialsMigration } from '../src/migrations/0003_access_credentials.js';
import { artifactLifecycleMigration } from '../src/migrations/0004_artifact_lifecycle.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('folder snapshot migration', () => {
  it('backfills existing artifacts and revisions as files before adding folder entries', async () => {
    const databaseName = `shelf_folder_migration_${randomBytes(8).toString('hex')}`;
    const targetUrl = new URL(adminConnectionString as string);
    targetUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
    try {
      const preFolder = new Migrator({
        db: database,
        provider: {
          async getMigrations() {
            return {
              '0001_initial': initialMigration,
              '0002_human_auth': humanAuthMigration,
              '0003_access_credentials': accessCredentialsMigration,
              '0004_artifact_lifecycle': artifactLifecycleMigration,
            };
          },
        },
      });
      const migrated = await preFolder.migrateToLatest();
      expect(migrated.error).toBeUndefined();
      await sql`
        insert into shelf_artifacts (
          artifact_id, installation_id, workspace_id, name, latest_revision_id
        ) values (
          'art_AAAAAAAAAAAAAAAAAAAAAA', 'installation-main', 'workspace-main', 'README.md', null
        )
      `.execute(database);
      await sql`
        insert into shelf_revisions (
          revision_id, installation_id, workspace_id, artifact_id, revision_number,
          content_id, content_hash, byte_count, original_file_name, media_type,
          provenance_classification, actor_id, operation, publisher_metadata, source_revision_id
        ) values (
          'rev_AAAAAAAAAAAAAAAAAAAAAA', 'installation-main', 'workspace-main',
          'art_AAAAAAAAAAAAAAAAAAAAAA', 1, 'cnt_0123456789abcdef0123456789abcdef',
          ${`sha256:${'a'.repeat(64)}`}, 7, 'README.md', 'text/markdown',
          'direct-publish', 'actor-agent', 'file.publish', '{}'::jsonb, null
        )
      `.execute(database);
      await sql`
        update shelf_artifacts set latest_revision_id = 'rev_AAAAAAAAAAAAAAAAAAAAAA'
        where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
      `.execute(database);

      await expect(migratePostgresToLatest(database)).resolves.toEqual([
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
      ]);
      const artifact = await sql<{ kind: string }>`
        select kind from shelf_artifacts where artifact_id = 'art_AAAAAAAAAAAAAAAAAAAAAA'
      `.execute(database);
      const revision = await sql<{ kind: string; total_byte_count: string; file_count: number }>`
        select kind, total_byte_count, file_count from shelf_revisions
        where revision_id = 'rev_AAAAAAAAAAAAAAAAAAAAAA'
      `.execute(database);
      const entries = await sql<{ count: string }>`
        select count(*)::text as count from shelf_revision_entries
      `.execute(database);

      expect(artifact.rows).toEqual([{ kind: 'file' }]);
      expect(revision.rows).toEqual([{ kind: 'file', total_byte_count: '7', file_count: 1 }]);
      expect(entries.rows).toEqual([{ count: '0' }]);
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
