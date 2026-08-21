import { describe, expect, it } from 'vitest';

import {
  type CommentRepository,
  CommentResolvedThreadEditError,
  CommentWriteDisabledError,
  createCommentService,
  type ShareRepository,
  type StoredCommentPost,
  type StoredCommentThread,
} from '../src/index.js';

const shareId = 'shr_AAAAAAAAAAAAAAAAAAAAAA';
const artifactId = 'art_BBBBBBBBBBBBBBBBBBBBBB';
const revisionId = 'rev_CCCCCCCCCCCCCCCCCCCCCC';

function share(commentPolicy: 'off' | 'private' | 'shared') {
  return {
    apiVersion: 'v1' as const,
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    shareId,
    artifactId,
    visibility: 'unlisted' as const,
    accessType: 'protected' as const,
    commentPolicy,
    publicCode: null,
    target: { mode: 'latest' as const },
    createdByActorId: 'actor-moderator',
    createdAt: '2026-08-19T10:00:00.000Z',
    expiresAt: null,
    maxSessions: null,
    sessionsUsed: 0,
    revokedAt: null,
    revokedByActorId: null,
  };
}

function harness(policy: 'off' | 'private' | 'shared') {
  let currentShare = share(policy);
  let visitorUpserts = 0;
  const threads = new Map<string, StoredCommentThread>();
  const posts = new Map<string, StoredCommentPost>();
  const comments: CommentRepository = {
    async upsertVisitor(input) {
      visitorUpserts += 1;
      return {
        installationId: input.installationId,
        visitorKey: input.visitorKey,
        displayName: input.displayName,
        createdAt: input.now,
        updatedAt: input.now,
      };
    },
    async createThread(input) {
      const thread = {
        installationId: input.installationId,
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        shareId: input.shareId,
        threadId: input.threadId,
        revisionId: input.revisionId,
        visibility: input.visibility,
        anchor: input.anchor,
        anchorStatus: 'exact' as const,
        resolvedAt: null,
        resolvedByActorId: null,
        createdAt: input.post.createdAt,
        updatedAt: input.post.createdAt,
        starterVisitorKey: input.post.visitorKey,
        posts: [{ ...input.post, threadId: input.threadId }],
      };
      threads.set(thread.threadId, thread);
      for (const post of thread.posts) posts.set(post.postId, post);
      return structuredClone(thread);
    },
    async createReply(input) {
      const thread = threads.get(input.threadId);
      if (thread === undefined) throw new Error('missing thread');
      const post = { ...input.post, threadId: input.threadId };
      thread.posts.push(post);
      posts.set(post.postId, post);
      return structuredClone(post);
    },
    async findThread(input) {
      const thread = threads.get(input.threadId);
      return thread === undefined ||
        thread.installationId !== input.installationId ||
        thread.workspaceId !== input.workspaceId
        ? undefined
        : structuredClone(thread);
    },
    async findPost(input) {
      const post = posts.get(input.postId);
      return post === undefined ? undefined : structuredClone(post);
    },
    async findPostContext(input) {
      for (const thread of threads.values()) {
        const post = thread.posts.find((candidate) => candidate.postId === input.postId);
        if (post !== undefined) return { post: structuredClone(post), shareId: thread.shareId };
      }
      return undefined;
    },
    async listThreads(input) {
      return {
        items: [...threads.values()]
          .filter((thread) => thread.shareId === input.shareId)
          .map((thread) => structuredClone(thread)),
        nextCursor: null,
      };
    },
    async listArtifactThreads() {
      return {
        items: [...threads.values()].map((thread) => structuredClone(thread)),
        nextCursor: null,
      };
    },
    async editPost(input) {
      const post = posts.get(input.postId);
      if (post === undefined) return undefined;
      post.body = input.body;
      post.editedAt = input.editedAt;
      return structuredClone(post);
    },
    async deletePost(input) {
      for (const thread of threads.values()) {
        const post = thread.posts.find((candidate) => candidate.postId === input.postId);
        if (post === undefined) continue;
        if (thread.posts[0]?.postId === input.postId) {
          threads.delete(thread.threadId);
          return structuredClone({ ...post, deletedAt: input.deletedAt });
        }
        post.deletedAt = input.deletedAt;
        return structuredClone(post);
      }
      return undefined;
    },
    async setPostHidden(input) {
      const post = posts.get(input.postId);
      if (post === undefined) return undefined;
      post.hiddenAt = input.hiddenAt;
      return structuredClone(post);
    },
    async setThreadResolved(input) {
      const thread = threads.get(input.threadId);
      if (thread === undefined) return undefined;
      thread.resolvedAt = input.resolvedAt;
      thread.resolvedByActorId = input.resolvedByActorId;
      return structuredClone(thread);
    },
    async summarizeArtifacts() {
      return [];
    },
  };
  const shares = {
    async findShare() {
      return currentShare;
    },
    async findRevisionForShare(id: string) {
      return id === revisionId
        ? {
            installationId: 'installation-main',
            workspaceId: 'workspace-main',
            artifactId,
            revision: {
              kind: 'file' as const,
              revisionId,
              revisionNumber: 1,
              originalFileName: 'notes.md',
              mediaType: 'text/markdown',
              contentHash: `sha256:${'a'.repeat(64)}`,
              byteCount: 1,
              createdAt: '2026-08-19T10:00:00.000Z',
              provenance: {
                classification: 'direct-publish' as const,
                observed: { actorId: 'actor-moderator', operation: 'file.publish' as const },
              },
              publisherMetadata: {},
            },
          }
        : undefined;
    },
  } as unknown as ShareRepository;
  const service = createCommentService({
    comments,
    shares,
    clock: () => new Date('2026-08-19T11:00:00.000Z'),
    generateThreadId: (() => {
      let i = 0;
      return () => `thd_${++i}`;
    })(),
    generatePostId: (() => {
      let i = 0;
      return () => `pst_${++i}`;
    })(),
  });
  return {
    service,
    comments,
    setPolicy: (value: 'off' | 'private' | 'shared') => {
      currentShare = share(value);
    },
    visitorUpserts: () => visitorUpserts,
  };
}

const anchor = {
  revisionId,
  kind: 'range' as const,
  startLine: 2,
  endLine: 4,
  quotedText: 'keep this',
};

describe('comment service', () => {
  it('snapshots private/shared visibility, reuses installation visitor identity, and blocks off writes', async () => {
    const privateHarness = harness('private');
    const first = await privateHarness.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'private note',
    });
    expect(first.posts[0]?.author).toMatchObject({
      kind: 'visitor',
      participantId: expect.stringMatching(/^pt_/u),
    });
    expect(first.permissions).toEqual({ canReply: true, canResolve: true, canReopen: false });
    expect(first.posts[0]?.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canModerate: false,
    });
    await expect(
      privateHarness.service.listThreads({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456' },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      privateHarness.service.listThreads({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        authority: {
          kind: 'visitor',
          visitorKey: 'visitor_digest_a_123456',
          displayName: 'A renamed',
        },
      }),
    ).resolves.toMatchObject({ items: expect.arrayContaining([expect.anything()]) });
    privateHarness.setPolicy('shared');
    await expect(
      privateHarness.service.createThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        revisionId,
        anchor: { revisionId, kind: 'file' },
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456', displayName: 'B' },
        body: 'shared note',
      }),
    ).resolves.toMatchObject({ visibility: 'shared' });
    const sharedViewerThreads = await privateHarness.service.listThreads({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456', displayName: 'B' },
    });
    expect(sharedViewerThreads.items).toHaveLength(1);
    expect(sharedViewerThreads.items[0]?.permissions).toEqual({
      canReply: true,
      canResolve: true,
      canReopen: false,
    });
    expect(sharedViewerThreads.items[0]?.posts[0]?.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canModerate: false,
    });
    privateHarness.setPolicy('off');
    await expect(
      privateHarness.service.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: first.threadId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'blocked',
      }),
    ).rejects.toBeInstanceOf(CommentWriteDisabledError);
    await expect(
      privateHarness.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        threadId: first.threadId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).rejects.toBeInstanceOf(CommentWriteDisabledError);
    await expect(
      privateHarness.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        postId: first.posts[0].postId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'blocked edit',
      }),
    ).rejects.toBeInstanceOf(CommentWriteDisabledError);
    await expect(
      privateHarness.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        postId: first.posts[0].postId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).rejects.toBeInstanceOf(CommentWriteDisabledError);
    await expect(
      privateHarness.service.listThreads({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.anything(), expect.anything()]),
    });
    const moderatorThreads = await privateHarness.service.listThreads({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      authority: { kind: 'moderator', actorId: 'actor-moderator' },
    });
    expect(moderatorThreads.items[0]?.permissions).toEqual({
      canReply: false,
      canResolve: true,
      canReopen: false,
    });
    expect(moderatorThreads.items[0]?.posts[0]?.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canModerate: true,
    });
  });

  it('enforces anchor revision/range, starter resolve, moderator reopen, ownership, and remap status', async () => {
    const h = harness('shared');
    await expect(
      h.service.createThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        revisionId,
        anchor: { ...anchor, startLine: 5, endLine: 2 },
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'invalid range',
      }),
    ).rejects.toBeDefined();
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'note',
    });
    const otherVisitorThreads = await h.service.listThreads({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456' },
    });
    expect(otherVisitorThreads.items[0]?.permissions).toEqual({
      canReply: true,
      canResolve: false,
      canReopen: false,
    });
    expect(otherVisitorThreads.items[0]?.posts[0]?.permissions).toEqual({
      canEdit: false,
      canDelete: false,
      canModerate: false,
    });
    await expect(
      h.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456', displayName: 'B' },
      }),
    ).rejects.toBeDefined();
    await expect(
      h.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).resolves.toMatchObject({
      resolvedAt: '2026-08-19T11:00:00.000Z',
      permissions: { canReply: false, canResolve: false, canReopen: false },
      posts: [{ permissions: { canEdit: false, canDelete: true } }],
    });
    await expect(
      h.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        reopen: true,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).rejects.toBeDefined();
    await expect(
      h.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        reopen: true,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
      }),
    ).resolves.toMatchObject({
      resolvedAt: null,
      permissions: { canReply: true, canResolve: true, canReopen: false },
    });
    await expect(
      h.service.listThreads({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        currentRevisionId: 'rev_DDDDDDDDDDDDDDDDDDDDDD',
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).resolves.toMatchObject({ items: [{ anchorStatus: 'outdated' }] });
    await expect(
      h.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: created.posts[0].postId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_b_123456', displayName: 'B' },
        body: 'nope',
      }),
    ).rejects.toBeDefined();
    await expect(
      h.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: created.posts[0].postId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      }),
    ).resolves.toMatchObject({ deletedAt: '2026-08-19T11:00:00.000Z' });
  });

  it('deleting the root post removes the whole thread while reply deletion stays soft', async () => {
    const h = harness('shared');
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'root',
    });
    const reply = await h.service.createReply({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      threadId: created.threadId,
      shareId,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'reply',
    });
    await expect(
      h.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: reply.postId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456' },
      }),
    ).resolves.toMatchObject({ deletedAt: '2026-08-19T11:00:00.000Z' });
    await expect(
      h.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: created.posts[0].postId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456' },
      }),
    ).resolves.toMatchObject({ deletedAt: '2026-08-19T11:00:00.000Z' });
    await expect(
      h.service.listThreads({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
      }),
    ).resolves.toMatchObject({ items: [] });
  });

  it('requires the expected share, allows moderator post management, and requires reopen before replies', async () => {
    const h = harness('shared');
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'note',
    });
    await h.service.resolveThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      threadId: created.threadId,
      shareId,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
    });
    await expect(
      h.service.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'blocked until reopen',
      }),
    ).rejects.toBeDefined();
    await expect(
      h.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: created.posts[0].postId,
        shareId,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
        body: 'moderator edit',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      h.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: created.posts[0].postId,
        shareId: 'shr_ZZZZZZZZZZZZZZZZZZZZZZ',
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'wrong share',
      }),
    ).rejects.toBeDefined();
    await h.service.resolveThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      threadId: created.threadId,
      authority: { kind: 'moderator', actorId: 'actor-moderator' },
      reopen: true,
    });
    const moderatorReply = await h.service.createReply({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      threadId: created.threadId,
      authority: { kind: 'moderator', actorId: 'actor-moderator' },
      body: 'moderator reply',
    });
    expect(moderatorReply.permissions).toEqual({
      canEdit: true,
      canDelete: true,
      canModerate: false,
    });
    await expect(
      h.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        postId: moderatorReply.postId,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
      }),
    ).resolves.toMatchObject({ deletedAt: '2026-08-19T11:00:00.000Z' });
    await expect(
      h.service.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        threadId: created.threadId,
        shareId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'reopened reply',
      }),
    ).resolves.toMatchObject({ author: { participantId: expect.stringMatching(/^pt_/u) } });
  });

  it('retains an existing visitor identity when mutation displayName is omitted', async () => {
    const h = harness('shared');
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'Ada' },
      body: 'original',
    });
    expect(h.visitorUpserts()).toBe(1);

    await expect(
      h.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        postId: created.posts[0].postId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456' },
        body: 'edited',
      }),
    ).resolves.toMatchObject({ body: 'edited', author: { displayName: 'Ada' } });
    await expect(
      h.service.resolveThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        threadId: created.threadId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456' },
      }),
    ).resolves.toMatchObject({ resolvedAt: '2026-08-19T11:00:00.000Z' });
    await expect(
      h.service.deletePost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        postId: created.posts[0].postId,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456' },
      }),
    ).resolves.toMatchObject({ deletedAt: '2026-08-19T11:00:00.000Z' });
    expect(h.visitorUpserts()).toBe(1);
  });

  it('validates visitor identity and body before rewriting visitor state', async () => {
    const h = harness('shared');
    const before = h.visitorUpserts();
    await expect(
      h.service.createThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        revisionId,
        anchor,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: '   ',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.visitorUpserts()).toBe(before);
    await expect(
      h.service.createThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        revisionId,
        anchor,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: ' ' },
        body: 'valid body',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(h.visitorUpserts()).toBe(before);
  });

  it('trims, requires, and bounds an optional moderator display name', async () => {
    const h = harness('shared');
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'starter',
    });
    const reply = (displayName?: string) =>
      h.service.createReply({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        threadId: created.threadId,
        authority: {
          kind: 'moderator',
          actorId: 'actor-moderator',
          ...(displayName === undefined ? {} : { displayName }),
        },
        body: 'moderator reply',
      });

    await expect(reply('  Grace Hopper  ')).resolves.toMatchObject({
      author: { kind: 'actor', actorId: 'actor-moderator', displayName: 'Grace Hopper' },
    });
    await expect(reply('n'.repeat(128))).resolves.toMatchObject({
      author: { displayName: 'n'.repeat(128) },
    });
    await expect(reply(' ')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(reply('n'.repeat(129))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    const anonymous = await reply();
    expect(anonymous.author).toMatchObject({ kind: 'actor', actorId: 'actor-moderator' });
    expect(anonymous.author).not.toHaveProperty('displayName');
  });

  it('maps comment repository failures to retryable service unavailable errors', async () => {
    const h = harness('shared');
    h.comments.createThread = async () => {
      throw new Error('database unavailable');
    };
    await expect(
      h.service.createThread({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        revisionId,
        anchor,
        authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
        body: 'valid body',
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  });

  it('maps a repository resolved-edit race to invalid request', async () => {
    const h = harness('shared');
    const created = await h.service.createThread({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      shareId,
      revisionId,
      anchor,
      authority: { kind: 'visitor', visitorKey: 'visitor_digest_a_123456', displayName: 'A' },
      body: 'note',
    });
    h.comments.editPost = async () => {
      throw new CommentResolvedThreadEditError();
    };
    await expect(
      h.service.editPost({
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        shareId,
        postId: created.posts[0].postId,
        authority: { kind: 'moderator', actorId: 'actor-moderator' },
        body: 'race',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
