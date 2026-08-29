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
    accessType: 'protected',
    publicCode: null,
    target,
    createdByActorId: 'actor-publisher',
    createdAt: '2026-08-17T12:00:00.000Z',
    expiresAt: null,
    maxSessions: null,
    sessionsUsed: 0,
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
    purpose: 'user-created',
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
      const input = {
        ...createInput(share(ids.latestShare), 'latest'),
        purpose: 'artifact-default' as const,
      };
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
      const customPermanentId = 'shr_ZZZZZZZZZZZZZZZZZZZZZZ';
      await repository.commitCreate(
        createInput(share(customPermanentId), 'custom-permanent-latest'),
      );
      await expect(
        repository.findArtifactDefaultShares({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId: ids.artifact,
        }),
      ).resolves.toMatchObject({
        protected: { shareId: ids.latestShare },
        generations: { protected: 1, public: 0 },
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
      await expect(
        repository.findArtifactDefaultShares({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId: ids.artifact,
        }),
      ).resolves.toEqual({ generations: { protected: 1, public: 0 } });
    } finally {
      await database.destroy();
    }
  });

  it('linearizes distinct actors creating the same active artifact default', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    const secondDatabase = createPostgresDatabase({ connectionString });
    try {
      const artifactId = 'art_TTTTTTTTTTTTTTTTTTTTTT';
      const revisionId = 'rev_UUUUUUUUUUUUUUUUUUUUUU';
      await sql`
        insert into shelf_actors (
          actor_id, installation_id, actor_kind, actor_name, auth_user_id,
          created_by_actor_id, created_at, disabled_at
        ) values (
          'actor-default-racer', 'installation-main', 'service', 'default racer', null,
          'actor-publisher', '2026-08-17T11:30:00.000Z'::timestamptz, null
        ) on conflict do nothing
      `.execute(firstDatabase);
      const published = publish(revisionId, '9');
      published.artifactId = artifactId;
      await new PostgresRevisionRepository(firstDatabase).commitPublish({
        namespace: {
          installationId: published.installationId,
          workspaceId: published.workspaceId,
          actorId: 'actor-publisher',
          operation: 'file.publish',
          key: 'default-race-artifact',
        },
        fingerprint: `publish-request/v1:sha256:${'9'.repeat(64)}`,
        result: published,
      });
      const left = {
        ...createInput({ ...share('shr_VVVVVVVVVVVVVVVVVVVVVV'), artifactId }, 'default-race-left'),
        purpose: 'artifact-default' as const,
      };
      const rightResult = {
        ...share('shr_WWWWWWWWWWWWWWWWWWWWWW'),
        artifactId,
        createdByActorId: 'actor-default-racer',
      };
      const right = {
        ...createInput(rightResult, 'default-race-right'),
        namespace: {
          ...createInput(rightResult, 'default-race-right').namespace,
          actorId: 'actor-default-racer',
        },
        purpose: 'artifact-default' as const,
      };

      const outcomes = await Promise.all([
        new PostgresShareRepository(firstDatabase).commitCreate(left),
        new PostgresShareRepository(secondDatabase).commitCreate(right),
      ]);

      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
        'committed',
        'default-conflict',
      ]);
      await expect(
        new PostgresShareRepository(firstDatabase).findArtifactDefaultShares({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          artifactId,
        }),
      ).resolves.toMatchObject({
        protected: { shareId: expect.stringMatching(/^shr_[VW]/u) },
        generations: { protected: 1, public: 0 },
      });
    } finally {
      await firstDatabase.destroy();
      await secondDatabase.destroy();
    }
  });

  it('resolves only Public selectors and consumes one lifetime unit for a live Protected receipt', async () => {
    const database = createPostgresDatabase({ connectionString });
    try {
      const repository = new PostgresShareRepository(database);
      const protectedId = 'shr_JJJJJJJJJJJJJJJJJJJJJJ';
      const publicId = 'shr_KKKKKKKKKKKKKKKKKKKKKK';
      await repository.commitCreate(
        createInput({ ...share(protectedId), maxSessions: 1 }, 'protected-policy'),
      );
      await repository.commitCreate(
        createInput(
          {
            ...share(publicId),
            accessType: 'public',
            publicCode: 'PublicCode12',
            expiresAt: '2026-08-20T12:00:00.000Z',
          },
          'public-policy',
        ),
      );
      const collisionId = 'shr_LLLLLLLLLLLLLLLLLLLLLL';
      await expect(
        repository.commitCreate(
          createInput(
            {
              ...share(collisionId),
              accessType: 'public',
              publicCode: 'PublicCode12',
              expiresAt: '2026-08-20T12:00:00.000Z',
            },
            'public-policy-collision',
          ),
        ),
      ).resolves.toEqual({ status: 'public-code-conflict' });
      await expect(
        repository.findCreateIdempotency({
          installationId: 'installation-main',
          workspaceId: 'workspace-main',
          actorId: 'actor-publisher',
          operation: 'share.create',
          key: 'public-policy-collision',
        }),
      ).resolves.toBeUndefined();
      await expect(
        repository.commitCreate(
          createInput(
            {
              ...share(collisionId),
              accessType: 'public',
              publicCode: 'OtherCode123',
              expiresAt: '2026-08-20T12:00:00.000Z',
            },
            'public-policy-collision',
          ),
        ),
      ).resolves.toMatchObject({ status: 'committed' });

      await expect(repository.resolvePublicShareTarget('PublicCode12')).resolves.toMatchObject({
        share: { shareId: publicId, accessType: 'public' },
      });
      await expect(
        repository.resolvePublicShareTarget(protectedId.slice(-12)),
      ).resolves.toBeUndefined();

      const request = {
        shareId: protectedId,
        sessionId: '00000000-0000-4000-8000-000000000001',
        now: '2026-08-18T12:00:00.000Z',
        receiptExpiresAt: '2026-08-19T12:00:00.000Z',
      };
      await expect(repository.establishProtectedSession(request)).resolves.toMatchObject({
        status: 'established',
        result: { share: { sessionsUsed: 1 } },
      });
      await expect(repository.establishProtectedSession(request)).resolves.toMatchObject({
        status: 'reused',
        result: { share: { sessionsUsed: 1 } },
      });
      await expect(
        repository.establishProtectedSession({
          ...request,
          sessionId: '00000000-0000-4000-8000-000000000002',
        }),
      ).resolves.toEqual({ status: 'unavailable' });

      const cleanupId = 'shr_MMMMMMMMMMMMMMMMMMMMMM';
      await repository.commitCreate(createInput(share(cleanupId), 'receipt-cleanup'));
      await repository.establishProtectedSession({
        shareId: cleanupId,
        sessionId: '00000000-0000-4000-8000-000000000003',
        now: '2026-08-18T12:00:00.000Z',
        receiptExpiresAt: '2026-08-18T13:00:00.000Z',
      });
      await expect(
        repository.establishProtectedSession({
          shareId: cleanupId,
          sessionId: '00000000-0000-4000-8000-000000000004',
          now: '2026-08-18T14:00:00.000Z',
          receiptExpiresAt: '2026-08-19T14:00:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'established', result: { share: { sessionsUsed: 2 } } });
    } finally {
      await database.destroy();
    }
  });

  it('admits exactly one independent connection into the final Protected slot', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    const secondDatabase = createPostgresDatabase({ connectionString });
    try {
      const shareId = 'shr_NNNNNNNNNNNNNNNNNNNNNN';
      const first = new PostgresShareRepository(firstDatabase);
      const second = new PostgresShareRepository(secondDatabase);
      const sameReceiptShareId = 'shr_OOOOOOOOOOOOOOOOOOOOOO';
      await first.commitCreate(
        createInput({ ...share(sameReceiptShareId), maxSessions: 2 }, 'same-receipt-race'),
      );
      const sameReceiptRequest = {
        shareId: sameReceiptShareId,
        sessionId: '00000000-0000-4000-8000-000000000007',
        now: '2026-08-18T12:00:00.000Z',
        receiptExpiresAt: '2026-08-19T12:00:00.000Z',
      };
      const sameReceipt = await Promise.all([
        first.establishProtectedSession(sameReceiptRequest),
        second.establishProtectedSession(sameReceiptRequest),
      ]);
      expect(sameReceipt.map((outcome) => outcome.status).sort()).toEqual([
        'established',
        'reused',
      ]);
      await expect(first.findShare(sameReceiptShareId)).resolves.toMatchObject({ sessionsUsed: 1 });

      await first.commitCreate(
        createInput({ ...share(shareId), maxSessions: 1 }, 'final-slot-race'),
      );
      const common = {
        shareId,
        now: '2026-08-18T12:00:00.000Z',
        receiptExpiresAt: '2026-08-19T12:00:00.000Z',
      };
      const [left, right] = await Promise.all([
        first.establishProtectedSession({
          ...common,
          sessionId: '00000000-0000-4000-8000-000000000005',
        }),
        second.establishProtectedSession({
          ...common,
          sessionId: '00000000-0000-4000-8000-000000000006',
        }),
      ]);
      expect([left.status, right.status].sort()).toEqual(['established', 'unavailable']);
      await expect(first.findShare(shareId)).resolves.toMatchObject({ sessionsUsed: 1 });
    } finally {
      await firstDatabase.destroy();
      await secondDatabase.destroy();
    }
  });

  it('does not deadlock establishment against artifact deletion or retain post-delete authority', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    const secondDatabase = createPostgresDatabase({ connectionString });
    try {
      const artifactId = 'art_PPPPPPPPPPPPPPPPPPPPPP';
      const revisionId = 'rev_QQQQQQQQQQQQQQQQQQQQQQ';
      const shareId = 'shr_RRRRRRRRRRRRRRRRRRRRRR';
      const result = publish(revisionId, '8');
      result.artifactId = artifactId;
      const revisions = new PostgresRevisionRepository(firstDatabase);
      await revisions.commitPublish({
        namespace: {
          installationId: result.installationId,
          workspaceId: result.workspaceId,
          actorId: 'actor-publisher',
          operation: 'file.publish',
          key: 'establishment-delete-race',
        },
        fingerprint: `publish-request/v1:sha256:${'8'.repeat(64)}`,
        result,
      });
      const first = new PostgresShareRepository(firstDatabase);
      const second = new PostgresShareRepository(secondDatabase);
      await first.commitCreate(
        createInput({ ...share(shareId), artifactId }, 'establishment-delete-share'),
      );
      const establishment = {
        shareId,
        sessionId: '00000000-0000-4000-8000-000000000008',
        now: '2026-08-18T12:00:00.000Z',
        receiptExpiresAt: '2026-08-19T12:00:00.000Z',
      };
      const [, deletion] = await Promise.all([
        first.establishProtectedSession(establishment),
        new PostgresRevisionRepository(secondDatabase).deleteArtifact({
          installationId: result.installationId,
          workspaceId: result.workspaceId,
          artifactId,
          actorId: 'actor-publisher',
          deletedAt: '2026-08-18T12:00:00.000Z',
          recoverableUntil: '2026-09-17T12:00:00.000Z',
          reason: 'manual',
        }),
      ]);
      expect(deletion.status).toBe('deleted');
      await expect(first.establishProtectedSession(establishment)).resolves.toEqual({
        status: 'unavailable',
      });
      await expect(second.resolveShareTarget(shareId)).resolves.toBeUndefined();
    } finally {
      await firstDatabase.destroy();
      await secondDatabase.destroy();
    }
  });

  it('atomically soft-deletes, revokes only active shares, and recovers without resurrecting them', async () => {
    const firstDatabase = createPostgresDatabase({ connectionString });
    const secondDatabase = createPostgresDatabase({ connectionString });
    try {
      const artifactId = 'art_FFFFFFFFFFFFFFFFFFFFFF';
      const revisionId = 'rev_GGGGGGGGGGGGGGGGGGGGGG';
      const activeShareId = 'shr_HHHHHHHHHHHHHHHHHHHHHH';
      const expiredShareId = 'shr_IIIIIIIIIIIIIIIIIIIIII';
      const revisions = new PostgresRevisionRepository(firstDatabase);
      const result = publish(revisionId, '7');
      result.artifactId = artifactId;
      await revisions.commitPublish({
        namespace: {
          installationId: result.installationId,
          workspaceId: result.workspaceId,
          actorId: 'actor-publisher',
          operation: 'file.publish',
          key: 'deletion-publish',
        },
        fingerprint: `publish-request/v1:sha256:${'7'.repeat(64)}`,
        result,
      });
      const shares = new PostgresShareRepository(firstDatabase);
      await shares.commitCreate(
        createInput({ ...share(activeShareId), artifactId }, 'delete-active'),
      );
      await shares.commitCreate(
        createInput(
          {
            ...share(expiredShareId),
            artifactId,
            expiresAt: '2026-08-18T12:00:00.000Z',
          },
          'delete-expired',
        ),
      );

      const request = {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        artifactId,
        actorId: 'actor-publisher',
        deletedAt: '2026-08-19T12:00:00.000Z',
        recoverableUntil: '2026-09-18T12:00:00.000Z',
        reason: 'manual' as const,
      };
      const concurrent = new PostgresRevisionRepository(secondDatabase);
      const [left, right] = await Promise.all([
        revisions.deleteArtifact(request),
        concurrent.deleteArtifact(request),
      ]);
      expect([left.status, right.status].sort()).toEqual(['already-deleted', 'deleted']);
      expect(left).toMatchObject({ revokedShareCount: 1 });
      expect(right).toMatchObject({ revokedShareCount: 1 });
      await expect(revisions.findArtifact(artifactId)).resolves.toBeUndefined();
      await expect(revisions.findRevision(revisionId)).resolves.toBeUndefined();
      await expect(shares.resolveShareTarget(activeShareId)).resolves.toBeUndefined();
      const rows = await firstDatabase
        .selectFrom('shelf_shares')
        .select(['share_id', 'revoked_at'])
        .where('artifact_id', '=', artifactId)
        .orderBy('share_id')
        .execute();
      expect(rows).toEqual([
        { share_id: activeShareId, revoked_at: new Date(request.deletedAt) },
        { share_id: expiredShareId, revoked_at: null },
      ]);

      await expect(
        revisions.recoverArtifact({
          namespace: {
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            actorId: request.actorId,
            operation: 'artifact.recover',
            key: 'recover-after-delete',
          },
          fingerprint: `artifact-recovery-request/v1:sha256:${'1'.repeat(64)}`,
          artifactId,
          recoveredAt: '2026-08-20T12:00:00.000Z',
        }),
      ).resolves.toMatchObject({ status: 'recovered', artifact: { artifactId } });
      await expect(revisions.findArtifact(artifactId)).resolves.toMatchObject({ artifactId });
      await expect(shares.findShare(activeShareId)).resolves.toMatchObject({
        revokedAt: request.deletedAt,
      });
      const secondDeletion = {
        ...request,
        deletedAt: '2026-10-01T12:00:00.000Z',
        recoverableUntil: '2026-10-31T12:00:00.000Z',
      };
      await expect(revisions.deleteArtifact(secondDeletion)).resolves.toMatchObject({
        status: 'deleted',
        revokedShareCount: 0,
      });
      await expect(
        revisions.recoverArtifact({
          namespace: {
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            actorId: request.actorId,
            operation: 'artifact.recover',
            key: 'recover-expired-delete',
          },
          fingerprint: `artifact-recovery-request/v1:sha256:${'2'.repeat(64)}`,
          artifactId,
          recoveredAt: secondDeletion.recoverableUntil,
        }),
      ).resolves.toEqual({ status: 'expired' });
      await expect(revisions.findArtifact(artifactId)).resolves.toBeUndefined();
    } finally {
      await firstDatabase.destroy();
      await secondDatabase.destroy();
    }
  });

  it('round-trips shared-history policy and enforces its Latest target invariant', async () => {
    const database = createPostgresDatabase({ connectionString });
    try {
      const repository = new PostgresShareRepository(database);
      const shareId = 'shr_KKKKKKKKKKKKKKKKKKKKKK';
      const historyShare = {
        ...share(shareId),
        revisionAccess: 'shared-history' as const,
        historyFromRevisionNumber: 1,
      };

      await expect(
        repository.commitCreate(createInput(historyShare, 'history-policy-roundtrip')),
      ).resolves.toMatchObject({ status: 'committed' });
      await expect(repository.findShare(shareId)).resolves.toMatchObject({
        revisionAccess: 'shared-history',
        historyFromRevisionNumber: 1,
        target: { mode: 'latest' },
      });
      await expect(
        database
          .updateTable('shelf_shares')
          .set({ target_mode: 'pinned', target_revision_id: ids.firstRevision })
          .where('share_id', '=', shareId)
          .execute(),
      ).rejects.toThrow(/shelf_shares_revision_access/u);
    } finally {
      await database.destroy();
    }
  });
});
