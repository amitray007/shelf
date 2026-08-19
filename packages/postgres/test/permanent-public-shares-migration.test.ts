import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createPostgresDatabase } from '../src/index.js';
import { initialMigration } from '../src/migrations/0001_initial.js';
import { humanAuthMigration } from '../src/migrations/0002_human_auth.js';
import { accessCredentialsMigration } from '../src/migrations/0003_access_credentials.js';
import { artifactLifecycleMigration } from '../src/migrations/0004_artifact_lifecycle.js';
import { folderSnapshotsMigration } from '../src/migrations/0005_folder_snapshots.js';
import { sharesMigration } from '../src/migrations/0006_shares.js';
import { artifactDeletionMigration } from '../src/migrations/0007_artifact_deletion.js';
import { workspacesMigration } from '../src/migrations/0008_workspaces.js';
import { shareAccessPoliciesMigration } from '../src/migrations/0009_share_access_policies.js';
import { permanentPublicSharesMigration } from '../src/migrations/0010_permanent_public_shares.js';
import { artifactDefaultSharesMigration } from '../src/migrations/0011_artifact_default_shares.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('permanent Public shares migration', () => {
  it('allows permanent Public rows and refuses a lossy rollback', async () => {
    const databaseName = `shelf_permanent_public_${randomBytes(8).toString('hex')}`;
    const targetUrl = new URL(adminConnectionString as string);
    targetUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
    try {
      const migrator = new Migrator({
        db: database,
        provider: {
          async getMigrations() {
            return {
              '0001_initial': initialMigration,
              '0002_human_auth': humanAuthMigration,
              '0003_access_credentials': accessCredentialsMigration,
              '0004_artifact_lifecycle': artifactLifecycleMigration,
              '0005_folder_snapshots': folderSnapshotsMigration,
              '0006_shares': sharesMigration,
              '0007_artifact_deletion': artifactDeletionMigration,
              '0008_workspaces': workspacesMigration,
              '0009_share_access_policies': shareAccessPoliciesMigration,
              '0010_permanent_public_shares': permanentPublicSharesMigration,
            };
          },
        },
      });
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-publisher', 'installation-main', 'service', 'publisher', null,
          null, '2026-08-19T00:00:00.000Z'::timestamptz, null
        )
      `.execute(database);
      await sql`
        insert into shelf_workspaces (
          installation_id, workspace_id, created_by_actor_id, created_at
        ) values (
          'installation-main', 'workspace-main', 'actor-publisher',
          '2026-08-19T00:00:00.000Z'::timestamptz
        )
      `.execute(database);
      await sql`
        insert into shelf_artifacts (
          artifact_id, installation_id, workspace_id, name, kind,
          latest_revision_id, created_at, updated_at
        ) values (
          'art_AAAAAAAAAAAAAAAAAAAAAA', 'installation-main', 'workspace-main', 'file.txt',
          'file', null, '2026-08-19T00:00:00.000Z'::timestamptz,
          '2026-08-19T00:00:00.000Z'::timestamptz
        )
      `.execute(database);
      await expect(
        sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            access_type, public_code, target_mode, target_revision_id,
            created_by_actor_id, created_at, expires_at, max_sessions, sessions_used,
            revoked_at, revoked_by_actor_id
          ) values (
            'shr_BBBBBBBBBBBBBBBBBBBBBB', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'public', 'PublicCode12',
            'latest', null, 'actor-publisher', '2026-08-19T00:00:00.000Z'::timestamptz,
            null, null, 0, null, null
          )
        `.execute(database),
      ).resolves.toBeDefined();
      await artifactDefaultSharesMigration.up?.(database);
      await expect(
        database
          .selectFrom('shelf_shares')
          .select('is_default')
          .where('share_id', '=', 'shr_BBBBBBBBBBBBBBBBBBBBBB')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ is_default: false });

      await database
        .updateTable('shelf_shares')
        .set({ is_default: true })
        .where('share_id', '=', 'shr_BBBBBBBBBBBBBBBBBBBBBB')
        .execute();
      await expect(
        sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            access_type, public_code, target_mode, target_revision_id,
            created_by_actor_id, created_at, expires_at, max_sessions, sessions_used,
            revoked_at, revoked_by_actor_id, is_default
          ) values (
            'shr_CCCCCCCCCCCCCCCCCCCCCC', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'public', 'OtherCode123',
            'latest', null, 'actor-publisher', '2026-08-19T00:01:00.000Z'::timestamptz,
            null, null, 0, null, null, true
          )
        `.execute(database),
      ).rejects.toMatchObject({
        constraint: 'shelf_shares_active_default_unique_idx',
      });
      await expect(
        sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            access_type, public_code, target_mode, target_revision_id,
            created_by_actor_id, created_at, expires_at, max_sessions, sessions_used,
            revoked_at, revoked_by_actor_id, is_default
          ) values (
            'shr_DDDDDDDDDDDDDDDDDDDDDD', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'public', 'CustomCode12',
            'latest', null, 'actor-publisher', '2026-08-19T00:02:00.000Z'::timestamptz,
            null, null, 0, null, null, false
          )
        `.execute(database),
      ).resolves.toBeDefined();
      await database
        .updateTable('shelf_shares')
        .set({
          revoked_at: new Date('2026-08-19T00:03:00.000Z'),
          revoked_by_actor_id: 'actor-publisher',
        })
        .where('share_id', '=', 'shr_BBBBBBBBBBBBBBBBBBBBBB')
        .execute();
      await expect(
        sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            access_type, public_code, target_mode, target_revision_id,
            created_by_actor_id, created_at, expires_at, max_sessions, sessions_used,
            revoked_at, revoked_by_actor_id, is_default
          ) values (
            'shr_EEEEEEEEEEEEEEEEEEEEEE', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'public', 'RepairCode12',
            'latest', null, 'actor-publisher', '2026-08-19T00:04:00.000Z'::timestamptz,
            null, null, 0, null, null, true
          )
        `.execute(database),
      ).resolves.toBeDefined();

      await expect(artifactDefaultSharesMigration.down?.(database)).resolves.toBeUndefined();
      await expect(permanentPublicSharesMigration.down?.(database)).rejects.toThrow(
        'Cannot require Public expiry while permanent Public shares exist.',
      );
    } finally {
      await database.destroy();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });
});
