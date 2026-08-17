import { randomBytes } from 'node:crypto';

import { createAccessCredentialService } from '@shelf/auth';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
} from '../src/index.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_auth_repo_test_${randomBytes(8).toString('hex')}`;
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

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('PostgresAuthRepository', () => {
  it('persists scoped credentials, rotation, revocation, and secret-free audit events', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    await migratePostgresToLatest(firstDatabase);
    await migratePostgresToLatest(firstDatabase);
    const firstRepository = new PostgresAuthRepository(firstDatabase);
    await firstRepository.createHumanActor({
      installationId: 'installation-main',
      actorId: 'act_owner_0000000000000000000000',
      actorName: 'Shelf Owner',
      authUserId: 'better-auth-owner-id',
      createdAt: new Date('2026-08-17T00:00:00.000Z'),
    });
    const first = createAccessCredentialService({ repository: firstRepository });
    const issued = await first.issueAgent({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: 'act_owner_0000000000000000000000',
      grants: [
        { workspaceId: 'workspace-main', action: 'file.publish' },
        { workspaceId: 'workspace-main', action: 'revision.read' },
      ],
    });
    await firstDatabase.destroy();

    const restartedDatabase = createPostgresDatabase({ connectionString });
    const restartedRepository = new PostgresAuthRepository(restartedDatabase);
    const restarted = createAccessCredentialService({ repository: restartedRepository });
    await expect(restarted.authenticate(issued.token)).resolves.toMatchObject({
      actorId: issued.actorId,
      credentialId: issued.credentialId,
    });
    await expect(
      restarted.authorize({
        installationId: 'installation-main',
        actorId: issued.actorId,
        workspaceId: 'workspace-main',
        action: 'revision.read',
      }),
    ).resolves.toBe(true);
    await expect(
      restarted.authorize({
        installationId: 'installation-main',
        actorId: issued.actorId,
        workspaceId: 'workspace-other',
        action: 'revision.read',
      }),
    ).resolves.toBe(false);

    const replacement = await restarted.rotate({
      credentialId: issued.credentialId,
      rotatedByActorId: 'act_owner_0000000000000000000000',
    });
    expect(replacement.actorId).toBe(issued.actorId);
    const concurrentResults = await Promise.all([
      restarted.authenticate(issued.token),
      restarted.revoke({
        credentialId: issued.credentialId,
        revokedByActorId: 'act_owner_0000000000000000000000',
      }),
      restarted.authenticate(issued.token),
    ]);
    expect(concurrentResults[1]).toBe(true);
    await expect(restarted.authenticate(issued.token)).resolves.toBeUndefined();
    await expect(restarted.authenticate(replacement.token)).resolves.toMatchObject({
      actorId: issued.actorId,
    });

    const summaries = await restartedRepository.listActorCredentials(issued.actorId);
    expect(summaries).toHaveLength(2);
    expect(JSON.stringify(summaries)).not.toContain(issued.token);
    expect(JSON.stringify(summaries)).not.toContain(replacement.token);
    const events = await restartedRepository.listAuthEvents('installation-main');
    expect(events.map((event) => event.eventType)).toEqual([
      'human-actor.created',
      'access-credential.issued',
      'access-credential.rotated',
      'access-credential.revoked',
    ]);
    expect(JSON.stringify(events)).not.toContain(issued.token);
    expect(JSON.stringify(events)).not.toContain(replacement.token);

    await expect(
      restarted.issueAgent({
        installationId: 'installation-other',
        actorName: 'cross-installation-agent',
        createdByActorId: 'act_owner_0000000000000000000000',
        grants: [],
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await restartedDatabase.destroy();
  });

  it('discovers actor workspaces and pages installation credentials without secret material', async () => {
    const database = createPostgresDatabase({ connectionString });
    await migratePostgresToLatest(database);
    const repository = new PostgresAuthRepository(database);
    const ownerId = 'act_dashboard_owner';
    await repository.createHumanActor({
      installationId: 'installation-dashboard',
      actorId: ownerId,
      actorName: 'Dashboard Owner',
      authUserId: 'better-auth-dashboard-owner',
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
      grants: [
        { workspaceId: 'workspace-b', action: 'revision.read' },
        { workspaceId: 'workspace-a', action: 'file.publish' },
      ],
    });
    await repository.createActorCredential({
      installationId: 'installation-dashboard',
      actorId: 'act_dashboard_first',
      actorName: 'first-agent',
      credentialId: `crd_${'a'.repeat(22)}`,
      digest: `sha256:${'1'.repeat(64)}`,
      grants: [
        {
          installationId: 'installation-dashboard',
          actorId: 'act_dashboard_first',
          workspaceId: 'workspace-a',
          action: 'file.publish',
        },
      ],
      createdByActorId: ownerId,
      createdAt: new Date('2026-08-18T01:00:00.000Z'),
    });
    await repository.createActorCredential({
      installationId: 'installation-dashboard',
      actorId: 'act_dashboard_second',
      actorName: 'second-agent',
      credentialId: `crd_${'b'.repeat(22)}`,
      digest: `sha256:${'2'.repeat(64)}`,
      grants: [
        {
          installationId: 'installation-dashboard',
          actorId: 'act_dashboard_second',
          workspaceId: 'workspace-b',
          action: 'revision.read',
        },
      ],
      createdByActorId: ownerId,
      createdAt: new Date('2026-08-18T02:00:00.000Z'),
    });

    await expect(
      repository.listActorGrants({
        installationId: 'installation-dashboard',
        actorId: ownerId,
      }),
    ).resolves.toMatchObject([
      { workspaceId: 'workspace-a', action: 'file.publish' },
      { workspaceId: 'workspace-b', action: 'revision.read' },
    ]);

    const first = await repository.listInstallationCredentialPage({
      installationId: 'installation-dashboard',
      limit: 1,
    });
    expect(first.items).toMatchObject([{ actorName: 'second-agent' }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await repository.listInstallationCredentialPage({
      installationId: 'installation-dashboard',
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ items: [{ actorName: 'first-agent' }] });
    expect(second.nextCursor).toBeUndefined();
    expect(JSON.stringify([first, second])).not.toContain('sha256:');

    await database.destroy();
  });
});
