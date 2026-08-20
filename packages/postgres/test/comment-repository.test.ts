import { randomBytes } from 'node:crypto';

import {
  CommentThreadPostLimitError,
  commentParticipantId,
  decodeCommentThreadCursor,
  type StoredPublish,
} from '@shelf/core';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresCommentRepository,
  PostgresRevisionRepository,
} from '../src/index.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_comment_repo_test_${randomBytes(8).toString('hex')}`;
const databaseUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (databaseUrl !== undefined) databaseUrl.pathname = `/${databaseName}`;
const connectionString = databaseUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

const ids = {
  main: {
    actor: 'actor-comment-main',
    artifact: 'art_comment_main',
    revision: 'rev_comment_main',
    share: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
    workspace: 'workspace-main',
    installation: 'installation-main',
  },
  other: {
    actor: 'actor-comment-other',
    artifact: 'art_comment_other',
    revision: 'rev_comment_other',
    share: 'shr_BBBBBBBBBBBBBBBBBBBBBB',
    workspace: 'workspace-other',
    installation: 'installation-other',
  },
} as const;

function publish(scope: (typeof ids)['main'] | (typeof ids)['other']): StoredPublish {
  const character = scope.installation === ids.main.installation ? 'a' : 'b';
  return {
    apiVersion: 'v1',
    installationId: scope.installation,
    workspaceId: scope.workspace,
    artifactId: scope.artifact,
    revisionId: scope.revision,
    content: {
      contentId: `cnt_comment_${character}`,
      contentHash: `sha256:${character.repeat(64)}`,
      byteCount: 11,
    },
    originalFileName: 'comments.md',
    mediaType: 'text/markdown',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: scope.actor, operation: 'file.publish' },
    },
    publisherMetadata: {},
  };
}

describePostgres('PostgresCommentRepository', () => {
  beforeAll(async () => {
    if (adminConnectionString === undefined) return;
    const admin = new Pool({ connectionString: adminConnectionString });
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await admin.end();
    }
    const database = createPostgresDatabase({ connectionString });
    try {
      await migratePostgresToLatest(database);
      for (const scope of [ids.main, ids.other]) {
        await sql`
          insert into shelf_actors (
            actor_id, installation_id, actor_kind, actor_name, auth_user_id,
            created_by_actor_id, created_at, disabled_at
          ) values (
            ${scope.actor}, ${scope.installation}, 'service', ${scope.actor}, null,
            null, '2026-08-17T11:00:00.000Z'::timestamptz, null
          )
        `.execute(database);
        const revision = publish(scope);
        await new PostgresRevisionRepository(database).commitPublish({
          namespace: {
            installationId: scope.installation,
            workspaceId: scope.workspace,
            actorId: scope.actor,
            operation: 'file.publish',
            key: `comment-repository-${scope.installation}`,
          },
          fingerprint: `publish-request/v1:sha256:${scope.installation === ids.main.installation ? 'a' : 'b'}${'0'.repeat(63)}`,
          result: revision,
        });
        await sql`
          insert into shelf_shares (
            share_id, installation_id, workspace_id, artifact_id, visibility,
            target_mode, target_revision_id, created_by_actor_id, created_at,
            expires_at, revoked_at, revoked_by_actor_id, access_type, public_code,
            max_sessions, sessions_used, is_default, comment_policy
          ) values (
            ${scope.share}, ${scope.installation}, ${scope.workspace}, ${scope.artifact},
            'unlisted', 'latest', null, ${scope.actor},
            '2026-08-17T12:00:00.000Z'::timestamptz, null, null, null,
            'protected', null, null, 0, false, 'shared'
          )
        `.execute(database);
      }
    } finally {
      await database.destroy();
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

  it('creates, scopes, mutates, summarizes, and bounds abuse cleanup', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresCommentRepository(database);
    const visitorKey = 'visitor-key-shared-across-installations';
    const visitor = {
      kind: 'visitor' as const,
      participantId: commentParticipantId('visitor', visitorKey),
      displayName: 'First name',
    };
    try {
      await repository.upsertVisitor({
        installationId: ids.main.installation,
        visitorKey,
        displayName: visitor.displayName,
        now: '2026-08-17T12:01:00.000Z',
      });
      await repository.upsertVisitor({
        installationId: ids.other.installation,
        visitorKey,
        displayName: 'Other installation',
        now: '2026-08-17T12:01:00.000Z',
      });
      const thread = await repository.createThread({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        artifactId: ids.main.artifact,
        shareId: ids.main.share,
        threadId: 'thread-comment-main',
        revisionId: ids.main.revision,
        visibility: 'shared',
        anchor: { kind: 'file', revisionId: ids.main.revision },
        post: {
          postId: 'post-comment-main',
          body: 'Please review this file.',
          author: visitor,
          visitorKey,
          actorId: null,
          createdAt: '2026-08-17T12:02:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
        abuse: {
          rotatingIpHash: 'ip-one',
          browser: 'browser-one',
          operatingSystem: 'os-one',
          expiresAt: '2026-08-18T12:02:00.000Z',
        },
      });
      expect(thread.posts).toHaveLength(1);
      await expect(
        repository.findThread({
          installationId: ids.other.installation,
          workspaceId: ids.main.workspace,
          threadId: thread.threadId,
        }),
      ).resolves.toBeUndefined();

      const reply = await repository.createReply({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        threadId: thread.threadId,
        post: {
          postId: 'post-comment-reply',
          body: 'I agree.',
          author: { kind: 'actor', participantId: 'actor:moderator', actorId: ids.main.actor },
          visitorKey: null,
          actorId: ids.main.actor,
          createdAt: '2026-08-17T12:03:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
        abuse: {
          rotatingIpHash: 'ip-two',
          browser: 'browser-two',
          operatingSystem: 'os-two',
          expiresAt: '2026-08-18T12:03:00.000Z',
        },
      });
      expect(reply.body).toBe('I agree.');
      await expect(
        repository.editPost({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          postId: reply.postId,
          body: 'I agree, updated.',
          editedAt: '2026-08-17T12:04:00.000Z',
        }),
      ).resolves.toMatchObject({ body: 'I agree, updated.' });
      await expect(
        repository.deletePost({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          postId: reply.postId,
          deletedAt: '2026-08-17T12:05:00.000Z',
        }),
      ).resolves.toMatchObject({ deletedAt: '2026-08-17T12:05:00.000Z' });
      await expect(
        repository.setThreadResolved({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          threadId: thread.threadId,
          resolvedAt: '2026-08-17T12:06:00.000Z',
          resolvedByActorId: ids.main.actor,
        }),
      ).resolves.toMatchObject({ resolvedByActorId: ids.main.actor });
      await expect(
        repository.editPost({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          postId: 'post-comment-main',
          body: 'should be rejected',
          editedAt: '2026-08-17T12:06:30.000Z',
        }),
      ).rejects.toThrow('resolved');

      await repository.upsertVisitor({
        installationId: ids.main.installation,
        visitorKey,
        displayName: 'Renamed visitor',
        now: '2026-08-17T12:07:00.000Z',
      });
      await expect(
        repository.findPost({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          postId: 'post-comment-main',
        }),
      ).resolves.toMatchObject({ author: { displayName: 'Renamed visitor' } });

      const summary = await repository.summarizeArtifacts({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        artifactIds: [ids.main.artifact, 'art_missing'],
      });
      expect(summary).toEqual([
        expect.objectContaining({
          artifactId: ids.main.artifact,
          participantCount: 2,
          openThreadCount: 0,
          openReplyCount: 0,
        }),
        expect.objectContaining({ artifactId: 'art_missing', participantCount: 0 }),
      ]);

      await expect(repository.cleanupExpiredAbuse('2026-08-19T00:00:00.000Z', 1)).resolves.toBe(1);
      const remaining = await sql<{ count: string }>`
        select count(*)::text as count
        from shelf_comment_posts
        where abuse_expires_at is not null
      `.execute(database);
      expect(remaining.rows[0]?.count).toBe('1');
      await expect(repository.cleanupExpiredAbuse('2026-08-19T00:00:00.000Z', 10)).resolves.toBe(1);
      await expect(
        repository.deletePost({
          installationId: ids.other.installation,
          workspaceId: ids.main.workspace,
          postId: 'post-comment-main',
          deletedAt: '2026-08-19T00:01:00.000Z',
        }),
      ).resolves.toBeUndefined();
      await expect(
        repository.deletePost({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          postId: 'post-comment-main',
          deletedAt: '2026-08-19T00:01:00.000Z',
        }),
      ).resolves.toMatchObject({
        postId: 'post-comment-main',
        deletedAt: '2026-08-19T00:01:00.000Z',
      });
      await expect(
        repository.findThread({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          threadId: thread.threadId,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await database.destroy();
    }
  });

  it('pages by latest activity and atomically caps replies at 100 posts', async () => {
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresCommentRepository(database);
    const actor = {
      kind: 'actor' as const,
      participantId: 'actor:moderator',
      actorId: ids.main.actor,
    };
    const pagingShare = 'shr_CCCCCCCCCCCCCCCCCCCCCC';
    try {
      await sql`
        insert into shelf_shares (
          share_id, installation_id, workspace_id, artifact_id, visibility,
          target_mode, target_revision_id, created_by_actor_id, created_at,
          expires_at, revoked_at, revoked_by_actor_id, access_type, public_code,
          max_sessions, sessions_used, is_default, comment_policy
        ) values (
          ${pagingShare}, ${ids.main.installation}, ${ids.main.workspace}, ${ids.main.artifact},
          'unlisted', 'latest', null, ${ids.main.actor}, '2026-08-18T11:00:00.000Z'::timestamptz,
          null, null, null, 'protected', null, null, 0, false, 'shared'
        )
      `.execute(database);
      for (let index = 0; index < 26; index += 1) {
        await repository.createThread({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          artifactId: ids.main.artifact,
          shareId: pagingShare,
          threadId: `thread-page-${index}`,
          revisionId: ids.main.revision,
          visibility: 'shared',
          anchor: { kind: 'file', revisionId: ids.main.revision },
          post: {
            postId: `post-page-${index}`,
            body: `page ${index}`,
            author: actor,
            visitorKey: null,
            actorId: ids.main.actor,
            createdAt: `2026-08-18T12:00:${String(index).padStart(2, '0')}.000Z`,
            editedAt: null,
            deletedAt: null,
            hiddenAt: null,
          },
        });
      }
      const first = await repository.listThreads({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        shareId: pagingShare,
        limit: 25,
      });
      expect(first.items).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await repository.listThreads({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        shareId: pagingShare,
        limit: 25,
        cursor: decodeCommentThreadCursor(first.nextCursor as string),
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.threadId).not.toBe(first.items[0]?.threadId);

      await repository.createThread({
        installationId: ids.main.installation,
        workspaceId: ids.main.workspace,
        artifactId: ids.main.artifact,
        shareId: pagingShare,
        threadId: 'thread-limit',
        revisionId: ids.main.revision,
        visibility: 'shared',
        anchor: { kind: 'file', revisionId: ids.main.revision },
        post: {
          postId: 'post-limit-0',
          body: 'limit',
          author: actor,
          visitorKey: null,
          actorId: ids.main.actor,
          createdAt: '2026-08-19T12:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
      });
      for (let index = 1; index < 99; index += 1) {
        await repository.createReply({
          installationId: ids.main.installation,
          workspaceId: ids.main.workspace,
          threadId: 'thread-limit',
          post: {
            postId: `post-limit-${index}`,
            body: `reply ${index}`,
            author: actor,
            visitorKey: null,
            actorId: ids.main.actor,
            createdAt: '2026-08-19T12:01:00.000Z',
            editedAt: null,
            deletedAt: null,
            hiddenAt: null,
          },
        });
      }
      const results = await Promise.allSettled(
        [99, 100].map((index) =>
          repository.createReply({
            installationId: ids.main.installation,
            workspaceId: ids.main.workspace,
            threadId: 'thread-limit',
            post: {
              postId: `post-limit-${index}`,
              body: `reply ${index}`,
              author: actor,
              visitorKey: null,
              actorId: ids.main.actor,
              createdAt: '2026-08-19T12:02:00.000Z',
              editedAt: null,
              deletedAt: null,
              hiddenAt: null,
            },
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === 'rejected' && result.reason instanceof CommentThreadPostLimitError,
        ),
      ).toHaveLength(1);
    } finally {
      await database.destroy();
    }
  });
});
