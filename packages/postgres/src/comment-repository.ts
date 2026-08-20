import type {
  CommentRepository,
  CommentSummary,
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
  commentParticipantId,
  encodeCommentThreadCursor,
} from '@shelf/core';
import { type Kysely, sql, type Transaction } from 'kysely';

import type {
  CommentPostTable,
  CommentThreadTable,
  CommentVisitorTable,
  ShelfPostgresDatabase,
  ShelfPostgresSchema,
} from './database.js';

type DatabaseExecutor = Kysely<ShelfPostgresSchema> | Transaction<ShelfPostgresSchema>;
type ThreadRow = CommentThreadTable;
type PostRow = CommentPostTable;
// Keep this projection cap aligned with the public contracts package.
const COMMENT_SUMMARY_RECENT_THREAD_LIMIT = 8;

type CommentSummaryAggregateRow = {
  artifact_id: string;
  participant_kind: 'visitor' | 'actor';
  participant_key: string;
  display_name: string;
  thread_id: string;
  thread_resolved_at: Date | null;
  latest_activity_at: Date;
  post_count: string;
  reply_count: string;
};

function storedVisitor(row: CommentVisitorTable): StoredCommentVisitor {
  return {
    installationId: row.installation_id,
    visitorKey: row.visitor_key,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function storedPost(row: PostRow): StoredCommentPost {
  const author =
    row.author_kind === 'visitor'
      ? {
          kind: 'visitor' as const,
          participantId: commentParticipantId('visitor', row.visitor_key as string),
          displayName: row.display_name as string,
        }
      : {
          kind: 'actor' as const,
          participantId: commentParticipantId('actor', row.actor_id as string),
          actorId: row.actor_id as string,
        };
  return {
    postId: row.post_id,
    threadId: row.thread_id,
    body: row.body,
    author,
    visitorKey: row.visitor_key,
    actorId: row.actor_id,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    hiddenAt: row.hidden_at?.toISOString() ?? null,
  };
}

function storedThread(row: ThreadRow, posts: StoredCommentPost[]): StoredCommentThread {
  const anchor =
    row.anchor_kind === 'range'
      ? {
          revisionId: row.revision_id,
          ...(row.anchor_path === null ? {} : { path: row.anchor_path }),
          kind: 'range' as const,
          startLine: row.anchor_start_line as number,
          endLine: row.anchor_end_line as number,
          ...(row.anchor_quoted_text === null ? {} : { quotedText: row.anchor_quoted_text }),
          ...(row.anchor_content_hash === null ? {} : { contentHash: row.anchor_content_hash }),
        }
      : {
          revisionId: row.revision_id,
          ...(row.anchor_path === null ? {} : { path: row.anchor_path }),
          kind: 'file' as const,
          ...(row.anchor_quoted_text === null ? {} : { quotedText: row.anchor_quoted_text }),
          ...(row.anchor_content_hash === null ? {} : { contentHash: row.anchor_content_hash }),
        };
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    shareId: row.share_id,
    threadId: row.thread_id,
    revisionId: row.revision_id,
    visibility: row.visibility,
    anchor,
    anchorStatus: row.anchor_status,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedByActorId: row.resolved_by_actor_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    starterVisitorKey: row.starter_visitor_key,
    posts,
  };
}

async function postsForThread(
  database: DatabaseExecutor,
  threadId: string,
): Promise<StoredCommentPost[]> {
  const rows = await database
    .selectFrom('shelf_comment_posts')
    .selectAll()
    .where('thread_id', '=', threadId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(storedPost);
}

async function postsForThreads(
  database: DatabaseExecutor,
  request: { installationId: string; workspaceId: string; threadIds: string[] },
): Promise<Map<string, StoredCommentPost[]>> {
  const byThread = new Map<string, StoredCommentPost[]>();
  if (request.threadIds.length === 0) return byThread;
  const rows = await database
    .selectFrom('shelf_comment_posts')
    .selectAll()
    .where('installation_id', '=', request.installationId)
    .where('workspace_id', '=', request.workspaceId)
    .where('thread_id', 'in', request.threadIds)
    .orderBy('created_at', 'asc')
    .execute();
  for (const row of rows) {
    const posts = byThread.get(row.thread_id) ?? [];
    posts.push(storedPost(row));
    byThread.set(row.thread_id, posts);
  }
  return byThread;
}

async function threadById(
  database: DatabaseExecutor,
  request: { installationId: string; workspaceId: string; threadId: string },
): Promise<StoredCommentThread | undefined> {
  const row = await database
    .selectFrom('shelf_comment_threads')
    .selectAll()
    .where('installation_id', '=', request.installationId)
    .where('workspace_id', '=', request.workspaceId)
    .where('thread_id', '=', request.threadId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : storedThread(row, await postsForThread(database, row.thread_id));
}

function postValues(
  input: Omit<StoredCommentPost, 'threadId'>,
  tenant: Pick<CreateCommentThreadInput, 'installationId' | 'workspaceId' | 'threadId'>,
  abuse?: CreateCommentThreadInput['abuse'] | CreateCommentReplyInput['abuse'],
): CommentPostTable {
  return {
    post_id: input.postId,
    thread_id: tenant.threadId,
    installation_id: tenant.installationId,
    workspace_id: tenant.workspaceId,
    author_kind: input.author.kind,
    visitor_key: input.visitorKey,
    actor_id: input.actorId,
    display_name: input.author.kind === 'visitor' ? input.author.displayName : null,
    body: input.body,
    created_at: new Date(input.createdAt),
    edited_at: input.editedAt === null ? null : new Date(input.editedAt),
    deleted_at: input.deletedAt === null ? null : new Date(input.deletedAt),
    hidden_at: input.hiddenAt === null ? null : new Date(input.hiddenAt),
    abuse_ip_hash: abuse?.rotatingIpHash ?? null,
    abuse_browser: abuse?.browser ?? null,
    abuse_operating_system: abuse?.operatingSystem ?? null,
    abuse_expires_at: abuse?.expiresAt === undefined ? null : new Date(abuse.expiresAt),
  };
}

export class PostgresCommentRepository implements CommentRepository {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  async cleanupExpiredAbuse(now: string, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
    return this.#database.transaction().execute(async (transaction) => {
      const expired = await transaction
        .selectFrom('shelf_comment_posts')
        .select('post_id')
        .where('abuse_expires_at', '<=', new Date(now))
        .orderBy('abuse_expires_at', 'asc')
        .orderBy('post_id', 'asc')
        .limit(limit)
        .execute();
      if (expired.length === 0) return 0;
      const result = await transaction
        .updateTable('shelf_comment_posts')
        .set({
          abuse_ip_hash: null,
          abuse_browser: null,
          abuse_operating_system: null,
          abuse_expires_at: null,
        })
        .where(
          'post_id',
          'in',
          expired.map((post) => post.post_id),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    });
  }

  async upsertVisitor(input: UpsertCommentVisitorInput): Promise<StoredCommentVisitor> {
    const row = await this.#database
      .insertInto('shelf_comment_visitors')
      .values({
        installation_id: input.installationId,
        visitor_key: input.visitorKey,
        display_name: input.displayName,
        created_at: new Date(input.now),
        updated_at: new Date(input.now),
      })
      .onConflict((conflict) =>
        conflict.columns(['installation_id', 'visitor_key']).doUpdateSet({
          display_name: input.displayName,
          updated_at: new Date(input.now),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#database
      .updateTable('shelf_comment_posts')
      .set({ display_name: input.displayName })
      .where('installation_id', '=', input.installationId)
      .where('visitor_key', '=', input.visitorKey)
      .where('display_name', '!=', input.displayName)
      .execute();
    return storedVisitor(row);
  }

  async createThread(input: CreateCommentThreadInput): Promise<StoredCommentThread> {
    const { anchor } = input;
    const inserted = await this.#database.transaction().execute(async (transaction) => {
      const thread = await transaction
        .insertInto('shelf_comment_threads')
        .values({
          thread_id: input.threadId,
          installation_id: input.installationId,
          workspace_id: input.workspaceId,
          artifact_id: input.artifactId,
          share_id: input.shareId,
          revision_id: input.revisionId,
          visibility: input.visibility,
          anchor_kind: anchor.kind,
          anchor_path: anchor.path ?? null,
          anchor_start_line: anchor.kind === 'range' ? (anchor.startLine as number) : null,
          anchor_end_line: anchor.kind === 'range' ? (anchor.endLine as number) : null,
          anchor_quoted_text: anchor.quotedText ?? null,
          anchor_content_hash: anchor.contentHash ?? null,
          anchor_status: 'exact',
          starter_visitor_key: input.post.visitorKey,
          resolved_at: null,
          resolved_by_actor_id: null,
          created_at: new Date(input.post.createdAt),
          updated_at: new Date(input.post.createdAt),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const values = postValues(input.post, input, input.abuse);
      const post = await transaction
        .insertInto('shelf_comment_posts')
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { post, thread };
    });
    return storedThread(inserted.thread, [storedPost(inserted.post)]);
  }

  async createReply(input: CreateCommentReplyInput): Promise<StoredCommentPost> {
    const values = postValues(input.post, input, input.abuse);
    const row = await this.#database.transaction().execute(async (transaction) => {
      const thread = await transaction
        .selectFrom('shelf_comment_threads')
        .select(['thread_id'])
        .where('installation_id', '=', input.installationId)
        .where('workspace_id', '=', input.workspaceId)
        .where('thread_id', '=', input.threadId)
        .forUpdate()
        .executeTakeFirst();
      if (thread === undefined) throw new Error('Comment thread was not found.');
      const postCount = await transaction
        .selectFrom('shelf_comment_posts')
        .select(({ fn }) => fn.count<number>('post_id').as('count'))
        .where('installation_id', '=', input.installationId)
        .where('workspace_id', '=', input.workspaceId)
        .where('thread_id', '=', input.threadId)
        .executeTakeFirstOrThrow();
      if (Number(postCount.count) >= 100) throw new CommentThreadPostLimitError();
      const inserted = await transaction
        .insertInto('shelf_comment_posts')
        .values(values)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('shelf_comment_threads')
        .set({ updated_at: new Date(input.post.createdAt) })
        .where('installation_id', '=', input.installationId)
        .where('workspace_id', '=', input.workspaceId)
        .where('thread_id', '=', input.threadId)
        .execute();
      return inserted;
    });
    return storedPost(row);
  }

  findThread(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
  }): Promise<StoredCommentThread | undefined> {
    return threadById(this.#database, request);
  }

  async findPost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<StoredCommentPost | undefined> {
    const row = await this.#database
      .selectFrom('shelf_comment_posts')
      .selectAll()
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('post_id', '=', request.postId)
      .executeTakeFirst();
    return row === undefined ? undefined : storedPost(row);
  }

  async findPostContext(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<{ post: StoredCommentPost; shareId: string } | undefined> {
    const row = await this.#database
      .selectFrom('shelf_comment_posts as post')
      .innerJoin('shelf_comment_threads as thread', (join) =>
        join
          .onRef('thread.thread_id', '=', 'post.thread_id')
          .onRef('thread.installation_id', '=', 'post.installation_id')
          .onRef('thread.workspace_id', '=', 'post.workspace_id'),
      )
      .selectAll('post')
      .select('thread.share_id')
      .where('post.installation_id', '=', request.installationId)
      .where('post.workspace_id', '=', request.workspaceId)
      .where('post.post_id', '=', request.postId)
      .executeTakeFirst();
    return row === undefined ? undefined : { post: storedPost(row), shareId: row.share_id };
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
    let query = this.#database
      .selectFrom('shelf_comment_threads')
      .selectAll()
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('share_id', '=', request.shareId);
    if (request.cursor !== undefined) {
      const updatedAt = new Date(request.cursor.updatedAt);
      query = query.where((eb) =>
        eb.or([
          eb('updated_at', '<', updatedAt),
          eb.and([
            eb('updated_at', '=', updatedAt),
            eb('thread_id', '<', request.cursor?.threadId ?? ''),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('thread_id', 'desc')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const selectedRows = rows.slice(0, request.limit);
    const postsByThread = await postsForThreads(this.#database, {
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      threadIds: selectedRows.map((row) => row.thread_id),
    });
    const items = selectedRows.map((row) =>
      storedThread(row, postsByThread.get(row.thread_id) ?? []),
    );
    const last = selectedRows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCommentThreadCursor({
              scope,
              updatedAt: last.updated_at.toISOString(),
              threadId: last.thread_id,
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
    let query = this.#database
      .selectFrom('shelf_comment_threads')
      .selectAll()
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('artifact_id', '=', request.artifactId);
    if (request.cursor !== undefined) {
      const updatedAt = new Date(request.cursor.updatedAt);
      query = query.where((eb) =>
        eb.or([
          eb('updated_at', '<', updatedAt),
          eb.and([
            eb('updated_at', '=', updatedAt),
            eb('thread_id', '<', request.cursor?.threadId ?? ''),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('thread_id', 'desc')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const selectedRows = rows.slice(0, request.limit);
    const postsByThread = await postsForThreads(this.#database, {
      installationId: request.installationId,
      workspaceId: request.workspaceId,
      threadIds: selectedRows.map((row) => row.thread_id),
    });
    const items = selectedRows.map((row) =>
      storedThread(row, postsByThread.get(row.thread_id) ?? []),
    );
    const last = selectedRows.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCommentThreadCursor({
              scope,
              updatedAt: last.updated_at.toISOString(),
              threadId: last.thread_id,
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
    const row = await this.#database
      .updateTable('shelf_comment_posts')
      .set({ body: request.body, edited_at: new Date(request.editedAt) })
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('post_id', '=', request.postId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : storedPost(row);
  }

  async deletePost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    deletedAt: string;
  }): Promise<StoredCommentPost | undefined> {
    const row = await this.#database
      .updateTable('shelf_comment_posts')
      .set({ deleted_at: new Date(request.deletedAt) })
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('post_id', '=', request.postId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : storedPost(row);
  }

  async setPostHidden(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    hiddenAt: string | null;
  }): Promise<StoredCommentPost | undefined> {
    const row = await this.#database
      .updateTable('shelf_comment_posts')
      .set({ hidden_at: request.hiddenAt === null ? null : new Date(request.hiddenAt) })
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('post_id', '=', request.postId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : storedPost(row);
  }

  async setThreadResolved(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
    resolvedAt: string | null;
    resolvedByActorId: string | null;
  }): Promise<StoredCommentThread | undefined> {
    const row = await this.#database
      .updateTable('shelf_comment_threads')
      .set({
        resolved_at: request.resolvedAt === null ? null : new Date(request.resolvedAt),
        resolved_by_actor_id: request.resolvedByActorId,
        updated_at: request.resolvedAt === null ? new Date() : new Date(request.resolvedAt),
      })
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('thread_id', '=', request.threadId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : storedThread(row, await postsForThread(this.#database, row.thread_id));
  }

  async summarizeArtifacts(request: {
    installationId: string;
    workspaceId: string;
    artifactIds: string[];
  }): Promise<CommentSummary[]> {
    if (request.artifactIds.length === 0) return [];
    const artifactIds = sql.join(
      request.artifactIds.map((artifactId) => sql`${artifactId}`),
      sql`, `,
    );
    // Aggregate in PostgreSQL to avoid materializing every comment post in the API process.
    // The result remains one row per participant/thread, which preserves exact counts and
    // leaves only the bounded recent-thread projection to TypeScript.
    const aggregateRows = (
      await sql<CommentSummaryAggregateRow>`
        with ranked_posts as (
          select
            thread.artifact_id,
            thread.thread_id,
            thread.resolved_at as thread_resolved_at,
            case when post.visitor_key is null then 'actor' else 'visitor' end as participant_kind,
            coalesce(post.visitor_key, 'actor:' || post.actor_id) as participant_key,
            coalesce(visitor.display_name, post.display_name, post.actor_id) as display_name,
            post.created_at,
            post.post_id,
            row_number() over (
              partition by post.thread_id
              order by post.created_at asc, post.post_id asc
            ) as post_position
          from shelf_comment_threads as thread
          inner join shelf_comment_posts as post
            on post.installation_id = thread.installation_id
            and post.workspace_id = thread.workspace_id
            and post.thread_id = thread.thread_id
          left join shelf_comment_visitors as visitor
            on visitor.installation_id = post.installation_id
            and visitor.visitor_key = post.visitor_key
          where thread.installation_id = ${request.installationId}
            and thread.workspace_id = ${request.workspaceId}
            and thread.artifact_id in (${artifactIds})
        )
        select
          artifact_id,
          participant_kind,
          participant_key,
          display_name,
          thread_id,
          thread_resolved_at,
          max(created_at) as latest_activity_at,
          count(*)::text as post_count,
          count(*) filter (where post_position > 1)::text as reply_count
        from ranked_posts
        group by artifact_id, participant_kind, participant_key, display_name,
          thread_id, thread_resolved_at
        order by artifact_id, latest_activity_at desc, thread_id, participant_key
      `.execute(this.#database)
    ).rows;

    return request.artifactIds.map((artifactId) => {
      const rows = aggregateRows.filter((row) => row.artifact_id === artifactId);
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
      const threadMap = new Map<string, { resolvedAt: Date | null; postCount: number }>();
      for (const row of rows) {
        const participantValue =
          row.participant_kind === 'visitor'
            ? row.participant_key
            : row.participant_key.slice('actor:'.length);
        const participantId = commentParticipantId(row.participant_kind, participantValue);
        const activity = row.latest_activity_at.toISOString();
        const current = participantMap.get(row.participant_key) ?? {
          participantId,
          displayName: row.display_name,
          threadCount: 0,
          replyCount: 0,
          latestThreadId: null,
          latestActivityAt: null,
          threadActivities: new Map<string, string>(),
        };
        current.threadCount += 1;
        current.replyCount += Number(row.reply_count);
        current.threadActivities.set(row.thread_id, activity);
        if (
          current.latestActivityAt === null ||
          activity > current.latestActivityAt ||
          (activity === current.latestActivityAt &&
            (current.latestThreadId === null || row.thread_id < current.latestThreadId))
        ) {
          current.latestActivityAt = activity;
          current.latestThreadId = row.thread_id;
        }
        participantMap.set(row.participant_key, current);
        const thread = threadMap.get(row.thread_id) ?? {
          resolvedAt: row.thread_resolved_at,
          postCount: 0,
        };
        thread.postCount += Number(row.post_count);
        threadMap.set(row.thread_id, thread);
      }
      const latest = rows[0];
      const openThreads = [...threadMap.values()].filter((thread) => thread.resolvedAt === null);
      return {
        artifactId,
        participantCount: participantMap.size,
        participants: [...participantMap.values()]
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
          .slice(0, 20),
        openThreadCount: openThreads.length,
        openReplyCount: openThreads.reduce(
          (count, thread) => count + Math.max(0, thread.postCount - 1),
          0,
        ),
        latestActivityAt: latest?.latest_activity_at.toISOString() ?? null,
        latestThreadId: latest?.thread_id ?? null,
      };
    });
  }
}
