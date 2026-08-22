import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
  PostgresRevisionRepository,
} from '../src/index.js';
import { workspaceDeletionMigration } from '../src/migrations/0014_workspace_deletion.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

const owner = 'act_owner_0000000000000000000000';
const installationId = 'installation-main';

async function waitForDatabaseConnectionsToClose(admin: Pool, databaseName: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const result = await admin.query<{ has_connections: boolean }>(
      `select exists (
        select 1 from pg_stat_activity where datname = $1
      ) as has_connections`,
      [databaseName],
    );
    if (result.rows[0]?.has_connections === false) return;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for PostgreSQL connections to ${databaseName} to close.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function withDatabase<T>(run: (database: ReturnType<typeof createPostgresDatabase>) => T) {
  const databaseName = `shelf_workspace_deletion_${randomBytes(8).toString('hex')}`;
  const targetUrl = new URL(adminConnectionString as string);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminConnectionString });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const database = createPostgresDatabase({ connectionString: targetUrl.toString() });
  try {
    await migratePostgresToLatest(database);
    await sql`
      insert into shelf_actors (
        actor_id, installation_id, actor_kind, actor_name, auth_user_id,
        created_by_actor_id, created_at, disabled_at
      ) values (
        ${owner}, ${installationId}, 'human', 'Shelf Owner', 'better-auth-owner',
        null, '2026-08-21T00:00:00.000Z'::timestamptz, null
      )
    `.execute(database);
    return await run(database);
  } finally {
    await database.destroy();
    await waitForDatabaseConnectionsToClose(admin, databaseName);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
}

async function seedArtifact(
  database: ReturnType<typeof createPostgresDatabase>,
  artifactId: string,
  workspaceId: string,
) {
  await sql`
    insert into shelf_artifacts (
      artifact_id, installation_id, workspace_id, name, kind,
      latest_revision_id, created_at, updated_at
    ) values (
      ${artifactId}, ${installationId}, ${workspaceId}, 'file.txt', 'file', null,
      '2026-08-21T00:00:00.000Z'::timestamptz, '2026-08-21T00:00:00.000Z'::timestamptz
    )
  `.execute(database);
}

describePostgres('workspace deletion persistence', () => {
  it('soft-deletes an empty workspace, stays idempotent, and records one audit event', async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresAuthRepository(database);
      await repository.createOwnedWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-empty',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await expect(
        repository.workspaceExists({ installationId, workspaceId: 'workspace-empty' }),
      ).resolves.toBe(true);

      await expect(
        repository.softDeleteWorkspace({
          installationId,
          actorId: owner,
          workspaceId: 'workspace-empty',
          deletedAt: new Date('2026-08-21T01:00:00.000Z'),
        }),
      ).resolves.toEqual({ workspaceId: 'workspace-empty', alreadyDeleted: false });

      // A deleted workspace disappears from existence checks and the session list.
      await expect(
        repository.workspaceExists({ installationId, workspaceId: 'workspace-empty' }),
      ).resolves.toBe(false);
      await expect(repository.listActorGrants({ installationId, actorId: owner })).resolves.toEqual(
        [],
      );

      // Repeating the delete is a success rather than a second write.
      await expect(
        repository.softDeleteWorkspace({
          installationId,
          actorId: owner,
          workspaceId: 'workspace-empty',
          deletedAt: new Date('2026-08-21T02:00:00.000Z'),
        }),
      ).resolves.toEqual({ workspaceId: 'workspace-empty', alreadyDeleted: true });

      const events = await database
        .selectFrom('shelf_auth_events')
        .select(['event_type', 'occurred_at'])
        .where('event_type', '=', 'workspace.deleted')
        .execute();
      expect(events).toEqual([
        { event_type: 'workspace.deleted', occurred_at: new Date('2026-08-21T01:00:00.000Z') },
      ]);

      const row = await database
        .selectFrom('shelf_workspaces')
        .select(['deleted_at', 'deleted_by_actor_id'])
        .where('workspace_id', '=', 'workspace-empty')
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        deleted_at: new Date('2026-08-21T01:00:00.000Z'),
        deleted_by_actor_id: owner,
      });
    });
  });

  it('keeps the deleted workspace ID reserved against recreation', async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresAuthRepository(database);
      await repository.createOwnedWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-reserved',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await repository.softDeleteWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-reserved',
        deletedAt: new Date('2026-08-21T01:00:00.000Z'),
      });

      await expect(
        repository.createOwnedWorkspace({
          installationId,
          actorId: owner,
          workspaceId: 'workspace-reserved',
          createdAt: new Date('2026-08-21T02:00:00.000Z'),
        }),
      ).rejects.toMatchObject({ name: 'WorkspaceAlreadyExistsError' });
    });
  });

  it('counts only active artifacts when deciding whether a workspace is empty', async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresAuthRepository(database);
      await repository.createOwnedWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-full',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await expect(
        repository.workspaceHasActiveArtifacts({ installationId, workspaceId: 'workspace-full' }),
      ).resolves.toBe(false);

      await seedArtifact(database, 'art_AAAAAAAAAAAAAAAAAAAAAA', 'workspace-full');
      await expect(
        repository.workspaceHasActiveArtifacts({ installationId, workspaceId: 'workspace-full' }),
      ).resolves.toBe(true);

      await database
        .updateTable('shelf_artifacts')
        .set({
          deleted_at: new Date('2026-08-21T01:00:00.000Z'),
          recoverable_until: new Date('2026-09-20T01:00:00.000Z'),
          deleted_by_actor_id: owner,
          deleted_share_count: 0,
          deletion_reason: 'manual',
          auto_trash_at: null,
        })
        .where('artifact_id', '=', 'art_AAAAAAAAAAAAAAAAAAAAAA')
        .execute();

      // A soft-deleted artifact no longer blocks workspace deletion.
      await expect(
        repository.workspaceHasActiveArtifacts({ installationId, workspaceId: 'workspace-full' }),
      ).resolves.toBe(false);
    });
  });

  it('blocks recovering a soft-deleted artifact back into a deleted workspace', async () => {
    await withDatabase(async (database) => {
      const auth = new PostgresAuthRepository(database);
      const revisions = new PostgresRevisionRepository(database);
      await auth.createOwnedWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-closing',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await seedArtifact(database, 'art_BBBBBBBBBBBBBBBBBBBBBB', 'workspace-closing');
      await expect(
        revisions.deleteArtifact({
          installationId,
          workspaceId: 'workspace-closing',
          artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
          actorId: owner,
          deletedAt: '2026-08-21T01:00:00.000Z',
          recoverableUntil: '2026-09-20T01:00:00.000Z',
          reason: 'manual',
        }),
      ).resolves.toMatchObject({ status: 'deleted' });

      await auth.softDeleteWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-closing',
        deletedAt: new Date('2026-08-21T02:00:00.000Z'),
      });

      // The artifact is still inside its recovery window, but its workspace is
      // gone, so recovery reports not-found rather than resurrecting it.
      await expect(
        revisions.recoverArtifact({
          namespace: {
            installationId,
            workspaceId: 'workspace-closing',
            actorId: owner,
            operation: 'artifact.recover' as const,
            key: 'recover-into-deleted-workspace',
          },
          fingerprint: `artifact-recovery-request/v1:sha256:${'1'.repeat(64)}`,
          artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
          recoveredAt: '2026-08-21T03:00:00.000Z',
        }),
      ).resolves.toEqual({ status: 'not-found' });

      const stillDeleted = await database
        .selectFrom('shelf_artifacts')
        .select('deleted_at')
        .where('artifact_id', '=', 'art_BBBBBBBBBBBBBBBBBBBBBB')
        .executeTakeFirstOrThrow();
      expect(stillDeleted.deleted_at).not.toBeNull();
    });
  });

  it('refuses a rollback that would discard deleted workspaces', async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresAuthRepository(database);
      await repository.createOwnedWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-rollback',
        createdAt: new Date('2026-08-21T00:00:00.000Z'),
      });
      await repository.softDeleteWorkspace({
        installationId,
        actorId: owner,
        workspaceId: 'workspace-rollback',
        deletedAt: new Date('2026-08-21T01:00:00.000Z'),
      });

      await expect(workspaceDeletionMigration.down?.(database)).rejects.toThrow(
        'Cannot remove workspace deletion migration while deleted workspaces exist.',
      );
    });
  });
});
