import { CommentThreadPostLimitError, commentParticipantId } from '@shelf/core';
import { describe, expect, it } from 'vitest';

import { MemoryCommentRepository } from '../src/adapters/memory-comment-repository.js';

describe('MemoryCommentRepository', () => {
  it('keeps visitor display names scoped to an installation', async () => {
    const repository = new MemoryCommentRepository();
    const visitorKey = 'visitor-key-shared-across-installations';
    const author = (displayName: string) => ({
      kind: 'visitor' as const,
      participantId: commentParticipantId('visitor', visitorKey),
      displayName,
    });
    await repository.upsertVisitor({
      installationId: 'installation-one',
      visitorKey,
      displayName: 'Installation one',
      now: '2026-08-17T12:00:00.000Z',
    });
    await repository.upsertVisitor({
      installationId: 'installation-two',
      visitorKey,
      displayName: 'Installation two',
      now: '2026-08-17T12:00:00.000Z',
    });
    await repository.createThread({
      installationId: 'installation-one',
      workspaceId: 'workspace-one',
      artifactId: 'artifact-one',
      shareId: 'share-one',
      threadId: 'thread-one',
      revisionId: 'revision-one',
      visibility: 'shared',
      anchor: { kind: 'file', revisionId: 'revision-one' },
      post: {
        postId: 'post-one',
        body: 'one',
        author: author('Installation one'),
        visitorKey,
        actorId: null,
        createdAt: '2026-08-17T12:01:00.000Z',
        editedAt: null,
        deletedAt: null,
        hiddenAt: null,
      },
    });
    await repository.createThread({
      installationId: 'installation-two',
      workspaceId: 'workspace-two',
      artifactId: 'artifact-two',
      shareId: 'share-two',
      threadId: 'thread-two',
      revisionId: 'revision-two',
      visibility: 'shared',
      anchor: { kind: 'file', revisionId: 'revision-two' },
      post: {
        postId: 'post-two',
        body: 'two',
        author: author('Installation two'),
        visitorKey,
        actorId: null,
        createdAt: '2026-08-17T12:01:00.000Z',
        editedAt: null,
        deletedAt: null,
        hiddenAt: null,
      },
    });

    await repository.upsertVisitor({
      installationId: 'installation-one',
      visitorKey,
      displayName: 'Renamed one',
      now: '2026-08-17T12:02:00.000Z',
    });
    await expect(
      repository.findPost({
        installationId: 'installation-one',
        workspaceId: 'workspace-one',
        postId: 'post-one',
      }),
    ).resolves.toMatchObject({ author: { displayName: 'Renamed one' } });
    await expect(
      repository.findPost({
        installationId: 'installation-two',
        workspaceId: 'workspace-two',
        postId: 'post-two',
      }),
    ).resolves.toMatchObject({ author: { displayName: 'Installation two' } });
  });

  it('rejects the 101st post in a thread', async () => {
    const repository = new MemoryCommentRepository();
    const visitorKey = 'visitor-key-with-100-posts';
    const post = (index: number) => ({
      postId: `post-${index}`,
      body: `body-${index}`,
      author: {
        kind: 'visitor' as const,
        participantId: commentParticipantId('visitor', visitorKey),
        displayName: 'Reviewer',
      },
      visitorKey,
      actorId: null,
      createdAt: `2026-08-17T12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
      editedAt: null,
      deletedAt: null,
      hiddenAt: null,
    });
    await repository.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      artifactId: 'artifact-main',
      shareId: 'share-main',
      threadId: 'thread-main',
      revisionId: 'revision-main',
      visibility: 'shared',
      anchor: { kind: 'file', revisionId: 'revision-main' },
      post: post(0),
    });
    for (let index = 1; index < 100; index += 1) {
      await repository.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: 'thread-main',
        post: post(index),
      });
    }
    await expect(
      repository.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: 'thread-main',
        post: post(100),
      }),
    ).rejects.toBeInstanceOf(CommentThreadPostLimitError);
  });

  it('deletes a thread and all replies without crossing tenant scope', async () => {
    const repository = new MemoryCommentRepository();
    const post = (postId: string) => ({
      postId,
      body: postId,
      author: {
        kind: 'visitor' as const,
        participantId: commentParticipantId('visitor', 'visitor-delete-scope'),
        displayName: 'Reviewer',
      },
      visitorKey: 'visitor-delete-scope',
      actorId: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      editedAt: null,
      deletedAt: null,
      hiddenAt: null,
    });
    await repository.createThread({
      installationId: 'installation-one',
      workspaceId: 'workspace-one',
      artifactId: 'artifact-one',
      shareId: 'share-one',
      threadId: 'thread-delete',
      revisionId: 'revision-one',
      visibility: 'shared',
      anchor: { kind: 'file', revisionId: 'revision-one' },
      post: post('root-delete'),
    });
    await repository.createReply({
      installationId: 'installation-one',
      workspaceId: 'workspace-one',
      threadId: 'thread-delete',
      post: post('reply-delete'),
    });
    await expect(
      repository.deleteThread({
        installationId: 'installation-two',
        workspaceId: 'workspace-one',
        threadId: 'thread-delete',
        deletedAt: '2026-08-17T12:01:00.000Z',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.deleteThread({
        installationId: 'installation-one',
        workspaceId: 'workspace-one',
        threadId: 'thread-delete',
        deletedAt: '2026-08-17T12:01:00.000Z',
      }),
    ).resolves.toMatchObject({ postId: 'root-delete', deletedAt: '2026-08-17T12:01:00.000Z' });
    await expect(
      repository.findPost({
        installationId: 'installation-one',
        workspaceId: 'workspace-one',
        postId: 'reply-delete',
      }),
    ).resolves.toBeUndefined();
  });
});
