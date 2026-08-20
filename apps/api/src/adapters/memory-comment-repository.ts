import { COMMENT_SUMMARY_RECENT_THREAD_LIMIT, type CommentSummary } from '@shelf/contracts';
import type {
  CommentRepository,
  CreateCommentReplyInput,
  CreateCommentThreadInput,
  StoredCommentPost,
  StoredCommentThread,
  StoredCommentVisitor,
  UpsertCommentVisitorInput,
} from '@shelf/core';
import {
  type CommentThreadCursor,
  type CommentThreadListScope,
  CommentThreadPostLimitError,
  commentCursorMatchesScope,
  commentParticipantId,
  encodeCommentThreadCursor,
} from '@shelf/core';

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Process-local comments adapter. Keys and metadata are never exposed by this adapter's output. */
export class MemoryCommentRepository implements CommentRepository {
  readonly #visitors = new Map<string, StoredCommentVisitor>();
  readonly #threads = new Map<string, StoredCommentThread>();

  async cleanupExpiredAbuse(_now: string, _limit: number): Promise<number> {
    // The process-local adapter deliberately does not retain abuse metadata.
    return 0;
  }

  async upsertVisitor(input: UpsertCommentVisitorInput): Promise<StoredCommentVisitor> {
    const key = `${input.installationId}\u0000${input.visitorKey}`;
    const existing = this.#visitors.get(key);
    const profile =
      existing === undefined
        ? {
            installationId: input.installationId,
            visitorKey: input.visitorKey,
            displayName: input.displayName,
            createdAt: input.now,
            updatedAt: input.now,
          }
        : { ...existing, displayName: input.displayName, updatedAt: input.now };
    this.#visitors.set(key, profile);
    for (const thread of this.#threads.values()) {
      for (const post of thread.posts) {
        if (
          thread.installationId === input.installationId &&
          post.visitorKey === input.visitorKey &&
          post.author.kind === 'visitor' &&
          post.author.displayName !== input.displayName
        ) {
          post.author.displayName = input.displayName;
        }
      }
    }
    return copy(profile);
  }

  async createThread(input: CreateCommentThreadInput): Promise<StoredCommentThread> {
    if (this.#threads.has(input.threadId)) throw new Error('Comment thread ID collision.');
    const thread: StoredCommentThread = {
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      artifactId: input.artifactId,
      shareId: input.shareId,
      threadId: input.threadId,
      revisionId: input.revisionId,
      visibility: input.visibility,
      anchor: copy(input.anchor),
      anchorStatus: 'exact',
      resolvedAt: null,
      resolvedByActorId: null,
      createdAt: input.post.createdAt,
      updatedAt: input.post.createdAt,
      starterVisitorKey: input.post.visitorKey,
      posts: [{ ...copy(input.post), threadId: input.threadId }],
    };
    this.#threads.set(input.threadId, thread);
    return copy(thread);
  }

  async createReply(input: CreateCommentReplyInput): Promise<StoredCommentPost> {
    const thread = this.#threads.get(input.threadId);
    if (
      thread === undefined ||
      thread.installationId !== input.installationId ||
      thread.workspaceId !== input.workspaceId
    )
      return Promise.reject(new Error('Comment thread not found.'));
    if (thread.posts.length >= 100) throw new CommentThreadPostLimitError();
    const post = { ...copy(input.post), threadId: input.threadId };
    thread.posts.push(post);
    thread.updatedAt = post.createdAt;
    return copy(post);
  }

  async findThread(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
  }): Promise<StoredCommentThread | undefined> {
    const thread = this.#threads.get(request.threadId);
    return thread === undefined ||
      thread.installationId !== request.installationId ||
      thread.workspaceId !== request.workspaceId
      ? undefined
      : copy(thread);
  }

  async findPost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<StoredCommentPost | undefined> {
    for (const thread of this.#threads.values()) {
      if (
        thread.installationId === request.installationId &&
        thread.workspaceId === request.workspaceId
      ) {
        const post = thread.posts.find((candidate) => candidate.postId === request.postId);
        if (post !== undefined) return copy(post);
      }
    }
    return undefined;
  }

  async findPostContext(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<{ post: StoredCommentPost; shareId: string } | undefined> {
    for (const thread of this.#threads.values()) {
      if (
        thread.installationId !== request.installationId ||
        thread.workspaceId !== request.workspaceId
      )
        continue;
      const post = thread.posts.find((candidate) => candidate.postId === request.postId);
      if (post !== undefined) return { post: copy(post), shareId: thread.shareId };
    }
    return undefined;
  }

  async listThreads(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    cursor?: CommentThreadCursor;
    limit: number;
    scope?: CommentThreadListScope;
  }): Promise<{ items: StoredCommentThread[]; nextCursor: string | null }> {
    const scope = request.scope ?? {
      kind: 'share' as const,
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      shareId: request.shareId,
    };
    const rows = [...this.#threads.values()]
      .filter(
        (thread) =>
          thread.installationId === request.installationId &&
          thread.workspaceId === request.workspaceId &&
          thread.shareId === request.shareId,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.threadId.localeCompare(left.threadId),
      )
      .filter((thread) => {
        if (request.cursor === undefined || !commentCursorMatchesScope(request.cursor, scope))
          return true;
        return (
          thread.updatedAt < request.cursor.updatedAt ||
          (thread.updatedAt === request.cursor.updatedAt &&
            thread.threadId < request.cursor.threadId)
        );
      });
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(copy);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCommentThreadCursor({
              scope,
              updatedAt: last.updatedAt,
              threadId: last.threadId,
            })
          : null,
    };
  }

  async listArtifactThreads(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    cursor?: CommentThreadCursor;
    limit: number;
    scope?: CommentThreadListScope;
  }): Promise<{ items: StoredCommentThread[]; nextCursor: string | null }> {
    const scope = request.scope ?? {
      kind: 'artifact' as const,
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      artifactId: request.artifactId,
    };
    const rows = [...this.#threads.values()]
      .filter(
        (thread) =>
          thread.installationId === request.installationId &&
          thread.workspaceId === request.workspaceId &&
          thread.artifactId === request.artifactId,
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.threadId.localeCompare(left.threadId),
      )
      .filter((thread) => {
        if (request.cursor === undefined || !commentCursorMatchesScope(request.cursor, scope))
          return true;
        return (
          thread.updatedAt < request.cursor.updatedAt ||
          (thread.updatedAt === request.cursor.updatedAt &&
            thread.threadId < request.cursor.threadId)
        );
      });
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(copy);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCommentThreadCursor({
              scope,
              updatedAt: last.updatedAt,
              threadId: last.threadId,
            })
          : null,
    };
  }

  async editPost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    body: string;
    editedAt: string;
  }): Promise<StoredCommentPost | undefined> {
    const post = this.#findMutablePost(request.installationId, request.workspaceId, request.postId);
    if (post === undefined) return undefined;
    post.body = request.body;
    post.editedAt = request.editedAt;
    return copy(post);
  }

  async deletePost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    deletedAt: string;
  }): Promise<StoredCommentPost | undefined> {
    const post = this.#findMutablePost(request.installationId, request.workspaceId, request.postId);
    if (post === undefined) return undefined;
    post.deletedAt = request.deletedAt;
    return copy(post);
  }

  async deleteThread(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
    deletedAt: string;
  }): Promise<StoredCommentPost | undefined> {
    const thread = this.#threads.get(request.threadId);
    if (
      thread === undefined ||
      thread.installationId !== request.installationId ||
      thread.workspaceId !== request.workspaceId
    )
      return undefined;
    const root = thread.posts[0];
    this.#threads.delete(request.threadId);
    return root === undefined ? undefined : copy({ ...root, deletedAt: request.deletedAt });
  }

  async setPostHidden(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    hiddenAt: string | null;
  }): Promise<StoredCommentPost | undefined> {
    const post = this.#findMutablePost(request.installationId, request.workspaceId, request.postId);
    if (post === undefined) return undefined;
    post.hiddenAt = request.hiddenAt;
    return copy(post);
  }

  async setThreadResolved(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
    resolvedAt: string | null;
    resolvedByActorId: string | null;
  }): Promise<StoredCommentThread | undefined> {
    const thread = this.#threads.get(request.threadId);
    if (
      thread === undefined ||
      thread.installationId !== request.installationId ||
      thread.workspaceId !== request.workspaceId
    )
      return undefined;
    thread.resolvedAt = request.resolvedAt;
    thread.resolvedByActorId = request.resolvedByActorId;
    thread.updatedAt = new Date().toISOString();
    return copy(thread);
  }

  async summarizeArtifacts(request: {
    installationId: string;
    workspaceId: string;
    artifactIds: string[];
  }): Promise<CommentSummary[]> {
    const wanted = new Set(request.artifactIds);
    return [...wanted].map((artifactId) => {
      const threads = [...this.#threads.values()].filter(
        (thread) =>
          thread.installationId === request.installationId &&
          thread.workspaceId === request.workspaceId &&
          thread.artifactId === artifactId,
      );
      const participantMap = new Map<
        string,
        {
          participantId: string;
          displayName: string;
          threadCount: number;
          replyCount: number;
          latestThreadId: string | null;
          latestActivityAt: string | null;
          threadActivities: Map<string, string>;
        }
      >();
      for (const thread of threads) {
        for (const post of thread.posts) {
          const key = post.visitorKey ?? `actor:${post.actorId ?? 'unknown'}`;
          const participantId = commentParticipantId(
            post.visitorKey === null ? 'actor' : 'visitor',
            post.visitorKey ?? post.actorId ?? 'unknown',
          );
          const current = participantMap.get(key) ?? {
            participantId,
            displayName:
              post.visitorKey === null
                ? post.author.kind === 'actor'
                  ? post.author.actorId
                  : post.author.displayName
                : (this.#visitors.get(`${request.installationId}\u0000${post.visitorKey}`)
                    ?.displayName ??
                  (post.author.kind === 'visitor' ? post.author.displayName : post.author.actorId)),
            threadCount: 0,
            replyCount: 0,
            latestThreadId: null,
            latestActivityAt: null,
            threadActivities: new Map(),
          };
          const previousThreadActivity = current.threadActivities.get(thread.threadId);
          if (previousThreadActivity === undefined || post.createdAt > previousThreadActivity) {
            current.threadActivities.set(thread.threadId, post.createdAt);
          }
          if (
            current.latestActivityAt === null ||
            post.createdAt > current.latestActivityAt ||
            (post.createdAt === current.latestActivityAt &&
              (current.latestThreadId === null || thread.threadId < current.latestThreadId))
          ) {
            current.latestActivityAt = post.createdAt;
            current.latestThreadId = thread.threadId;
          }
          participantMap.set(key, current);
        }
      }
      for (const thread of threads) {
        const seen = new Set<string>();
        for (const post of thread.posts) {
          const key = post.visitorKey ?? `actor:${post.actorId ?? 'unknown'}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const current = participantMap.get(key);
          if (current !== undefined) current.threadCount += 1;
        }
        for (const post of thread.posts.slice(1)) {
          const key = post.visitorKey ?? `actor:${post.actorId ?? 'unknown'}`;
          const current = participantMap.get(key);
          if (current !== undefined) current.replyCount += 1;
        }
      }
      const participants = [...participantMap.values()]
        .sort(
          (left, right) =>
            (right.latestActivityAt ?? '').localeCompare(left.latestActivityAt ?? '') ||
            left.participantId.localeCompare(right.participantId),
        )
        .map(({ threadActivities, ...participant }) => ({
          ...participant,
          recentThreads: [...threadActivities.entries()]
            .sort(
              (left, right) => right[1].localeCompare(left[1]) || left[0].localeCompare(right[0]),
            )
            .slice(0, COMMENT_SUMMARY_RECENT_THREAD_LIMIT)
            .map(([threadId, latestActivityAt]) => ({ threadId, latestActivityAt })),
        }))
        .slice(0, 20);
      const open = threads.filter((thread) => thread.resolvedAt === null);
      const latest = threads
        .flatMap((thread) => thread.posts.map((post) => ({ thread, at: post.createdAt })))
        .sort((left, right) => right.at.localeCompare(left.at))[0];
      return {
        artifactId,
        participantCount: participantMap.size,
        participants,
        openThreadCount: open.length,
        openReplyCount: open.reduce(
          (count, thread) => count + Math.max(0, thread.posts.length - 1),
          0,
        ),
        latestActivityAt: latest?.at ?? null,
        latestThreadId: latest?.thread.threadId ?? null,
      };
    });
  }

  #findMutablePost(
    installationId: string,
    workspaceId: string,
    postId: string,
  ): StoredCommentPost | undefined {
    for (const thread of this.#threads.values()) {
      if (thread.installationId !== installationId || thread.workspaceId !== workspaceId) continue;
      const post = thread.posts.find((candidate) => candidate.postId === postId);
      if (post !== undefined) return post;
    }
    return undefined;
  }
}
