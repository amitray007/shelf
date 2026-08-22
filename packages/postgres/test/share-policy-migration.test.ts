import { randomBytes } from 'node:crypto';

import type { StoredPublish } from '@shelf/core';
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

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('share access policy migration', () => {
  it('preserves legacy state, enforces policy combinations, and refuses every lossy rollback state', async () => {
    const databaseName = `shelf_share_policy_migration_${randomBytes(8).toString('hex')}`;
    const targetUrl = new URL(adminConnectionString as string);
    targetUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
    try {
      const prePolicy = new Migrator({
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
            };
          },
        },
      });
      expect((await prePolicy.migrateToLatest()).error).toBeUndefined();
      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-publisher', 'installation-main', 'service', 'publisher', null,
          null, '2026-08-17T11:00:00.000Z'::timestamptz, null
        )
      `.execute(database);
      const publish: StoredPublish = {
        apiVersion: 'v1',
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
        revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
        content: {
          contentId: `cnt_${'a'.repeat(32)}`,
          contentHash: `sha256:${'a'.repeat(64)}`,
          byteCount: 1,
        },
        originalFileName: 'legacy.txt',
        mediaType: 'text/plain',
        provenance: {
          classification: 'direct-publish',
          observed: { actorId: 'actor-publisher', operation: 'file.publish' },
        },
        publisherMetadata: {},
      };
      await database.transaction().execute(async (transaction) => {
        await sql`
          insert into shelf_artifacts (
            artifact_id, installation_id, workspace_id, latest_revision_id, name, kind
          ) values (
            ${publish.artifactId}, ${publish.installationId}, ${publish.workspaceId},
            null, ${publish.originalFileName}, 'file'
          )
        `.execute(transaction);
        await sql`
          insert into shelf_revisions (
            revision_id, installation_id, workspace_id, artifact_id, revision_number,
            content_id, content_hash, byte_count, original_file_name, media_type,
            provenance_classification, actor_id, operation, publisher_metadata,
            source_revision_id, kind, total_byte_count, file_count
          ) values (
            ${publish.revisionId}, ${publish.installationId}, ${publish.workspaceId},
            ${publish.artifactId}, 1, ${publish.content.contentId}, ${publish.content.contentHash},
            ${publish.content.byteCount}, ${publish.originalFileName}, ${publish.mediaType},
            'direct-publish', 'actor-publisher', 'file.publish',
            ${JSON.stringify(publish.publisherMetadata)}::jsonb, null, 'file',
            ${publish.content.byteCount}, 1
          )
        `.execute(transaction);
        await sql`
          update shelf_artifacts
          set latest_revision_id = ${publish.revisionId}
          where artifact_id = ${publish.artifactId}
        `.execute(transaction);
      });
      const legacyFingerprint = `share-create-request/v1:sha256:${'b'.repeat(64)}`;
      await database.transaction().execute(async (transaction) => {
        await sql`
          insert into shelf_share_idempotency (
            installation_id, workspace_id, actor_id, operation, client_key,
            fingerprint, share_id
          ) values (
            'installation-main', 'workspace-main', 'actor-publisher', 'share.create',
            'legacy-share', ${legacyFingerprint}, 'shr_BBBBBBBBBBBBBBBBBBBBBB'
          )
        `.execute(transaction);
        await sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            target_mode, target_revision_id, created_by_actor_id, created_at,
            expires_at, revoked_at, revoked_by_actor_id
          ) values (
            'shr_BBBBBBBBBBBBBBBBBBBBBB', 'installation-main', 'workspace-main',
            'art_AAAAAAAAAAAAAAAAAAAAAA', 'unlisted', 'latest', null,
            'actor-publisher', '2026-08-17T12:00:00.000Z'::timestamptz,
            null, null, null
          )
        `.execute(transaction);
      });

      await shareAccessPoliciesMigration.up?.(database);
      const legacy = await sql<{
        access_type: string;
        public_code: string | null;
        max_sessions: number | null;
        sessions_used: string;
        fingerprint: string;
      }>`
        select share.access_type, share.public_code, share.max_sessions,
               share.sessions_used::text, idempotency.fingerprint
        from shelf_shares as share
        join shelf_share_idempotency as idempotency using (share_id)
        where share.share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);
      expect(legacy.rows).toEqual([
        {
          access_type: 'protected',
          public_code: null,
          max_sessions: null,
          sessions_used: '0',
          fingerprint: legacyFingerprint,
        },
      ]);

      await expect(
        sql`
        update shelf_shares set access_type = 'public', public_code = 'PublicCode12'
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database),
      ).rejects.toThrow(/shelf_shares_access_policy/u);
      await expect(
        sql`
          update shelf_shares set max_sessions = 1, sessions_used = 2
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
        `.execute(database),
      ).rejects.toThrow(/shelf_shares_sessions_used/u);
      await expect(
        sql`
          update shelf_shares
          set access_type = 'public', public_code = 'PublicCode12',
              expires_at = '2026-08-19T12:00:00Z'::timestamptz,
              sessions_used = 1
          where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
        `.execute(database),
      ).rejects.toThrow(/shelf_shares_access_policy/u);
      await expect(
        sql`
        update shelf_share_idempotency
        set fingerprint = ${`share-create-request/v2:sha256:${'c'.repeat(64)}`}
      `.execute(database),
      ).resolves.toBeDefined();
      await expect(shareAccessPoliciesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove share access policies while policy state exists.',
      );
      await sql`update shelf_share_idempotency set fingerprint = ${legacyFingerprint}`.execute(
        database,
      );

      await sql`
        update shelf_shares
        set access_type = 'public', public_code = 'PublicCode12',
            expires_at = '2026-08-19T12:00:00Z'::timestamptz
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);
      await expect(shareAccessPoliciesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove share access policies while policy state exists.',
      );
      await sql`
        update shelf_shares
        set access_type = 'protected', public_code = null, expires_at = null
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);

      await sql`
        insert into shelf_share_session_receipts (
          share_id, session_id, established_at, receipt_expires_at
        ) values (
          'shr_BBBBBBBBBBBBBBBBBBBBBB', '00000000-0000-4000-8000-000000000001',
          '2026-08-18T12:00:00Z'::timestamptz, '2026-08-19T12:00:00Z'::timestamptz
        )
      `.execute(database);
      await expect(shareAccessPoliciesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove share access policies while policy state exists.',
      );
      await sql`delete from shelf_share_session_receipts`.execute(database);

      await sql`
        update shelf_shares set max_sessions = 1
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);
      await expect(shareAccessPoliciesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove share access policies while policy state exists.',
      );
      await sql`
        update shelf_shares set max_sessions = null, sessions_used = 1
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);
      await expect(shareAccessPoliciesMigration.down?.(database)).rejects.toThrow(
        'Cannot remove share access policies while policy state exists.',
      );
      await sql`
        update shelf_shares set sessions_used = 0
        where share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);

      await shareAccessPoliciesMigration.down?.(database);
      const afterDown = await sql<{ fingerprint: string; access_type: string | null }>`
        select idempotency.fingerprint,
               column_info.column_name as access_type
        from shelf_share_idempotency as idempotency
        left join information_schema.columns as column_info
          on column_info.table_schema = 'public'
         and column_info.table_name = 'shelf_shares'
         and column_info.column_name = 'access_type'
        where idempotency.share_id = 'shr_BBBBBBBBBBBBBBBBBBBBBB'
      `.execute(database);
      expect(afterDown.rows).toEqual([{ fingerprint: legacyFingerprint, access_type: null }]);
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
