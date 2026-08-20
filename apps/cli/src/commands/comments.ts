import type { CommentPost, CommentSummary, CommentThread } from '@shelf/contracts';

import {
  listArtifactComments,
  moderateArtifactCommentPost,
  replyArtifactComment,
  setArtifactCommentStatus,
  summarizeArtifactComments,
} from '../client.js';
import { resolveWorkspaceContext, transportFields } from '../context.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

interface ArtifactCommentsCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  artifact: string;
  allowInsecureLoopback?: boolean;
}

export interface ListCommentsCommandOptions extends ArtifactCommentsCommandOptions {
  revision?: string;
  cursor?: string;
  limit?: string;
}

export interface ReplyCommentCommandOptions extends ArtifactCommentsCommandOptions {
  thread: string;
  body: string;
  displayName?: string;
}

export interface ThreadStatusCommandOptions extends ArtifactCommentsCommandOptions {
  thread: string;
}

export interface PostModerationCommandOptions extends ArtifactCommentsCommandOptions {
  post: string;
}

/** Matches the summarizeCommentsV1 request schema batch bound in apps/api/src/routes/comments.ts. */
const COMMENT_SUMMARY_BATCH_LIMIT = 100;

export interface CommentSummariesCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  artifact: readonly string[];
  allowInsecureLoopback?: boolean;
}

function artifactId(value: string): string {
  if (!/^art_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The artifact ID is invalid.');
  return value;
}

function revisionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^rev_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The revision ID is invalid.');
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function commentId(value: string, label: 'thread' | 'post'): string {
  if (value.length === 0 || value.length > 128 || hasControlCharacter(value)) {
    throw usageFailure(`The ${label} ID is invalid.`);
  }
  return value;
}

function body(value: string): string {
  if (value.trim().length === 0 || value.length > 20_000) {
    throw usageFailure('The comment body must contain text and be at most 20000 characters.');
  }
  return value;
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || hasControlCharacter(trimmed)) {
    throw usageFailure('The display name must contain 1 to 128 characters.');
  }
  return trimmed;
}

function summaryArtifactIds(values: readonly string[]): string[] {
  if (values.length === 0) throw usageFailure('At least one --artifact is required.');
  if (values.length > COMMENT_SUMMARY_BATCH_LIMIT) {
    throw usageFailure(
      `A comment summary batch accepts at most ${COMMENT_SUMMARY_BATCH_LIMIT} artifacts.`,
    );
  }
  const ids = values.map((value) => artifactId(value));
  if (new Set(ids).size !== ids.length) {
    throw usageFailure('A comment summary batch must not repeat an artifact.');
  }
  return ids;
}

function pageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw usageFailure('The comment page limit is invalid.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw usageFailure('The comment page limit must be between 1 and 50.');
  }
  return parsed;
}

async function transport(options: ArtifactCommentsCommandOptions, runtime: CliRuntime) {
  const context = await resolveWorkspaceContext(options, runtime);
  return {
    ...transportFields(context),
    workspaceId: context.workspaceId,
    artifactId: artifactId(options.artifact),
  };
}

export async function executeListComments(
  options: ListCommentsCommandOptions,
  runtime: CliRuntime,
): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
  const selectedRevision = revisionId(options.revision);
  const limit = pageLimit(options.limit);
  return listArtifactComments(
    {
      ...(await transport(options, runtime)),
      ...(selectedRevision === undefined ? {} : { revisionId: selectedRevision }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(limit === undefined ? {} : { limit }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeReplyComment(
  options: ReplyCommentCommandOptions,
  runtime: CliRuntime,
): Promise<CommentPost> {
  const name = displayName(options.displayName);
  return replyArtifactComment(
    {
      ...(await transport(options, runtime)),
      threadId: commentId(options.thread, 'thread'),
      body: body(options.body),
      ...(name === undefined ? {} : { displayName: name }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeCommentSummaries(
  options: CommentSummariesCommandOptions,
  runtime: CliRuntime,
): Promise<{ items: CommentSummary[] }> {
  const artifactIds = summaryArtifactIds(options.artifact);
  const context = await resolveWorkspaceContext(options, runtime);
  return summarizeArtifactComments(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      artifactIds,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

async function executeThreadStatus(
  options: ThreadStatusCommandOptions,
  status: 'resolve' | 'reopen',
  runtime: CliRuntime,
): Promise<CommentThread> {
  return setArtifactCommentStatus(
    {
      ...(await transport(options, runtime)),
      threadId: commentId(options.thread, 'thread'),
      status,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeResolveComment(
  options: ThreadStatusCommandOptions,
  runtime: CliRuntime,
): Promise<CommentThread> {
  return executeThreadStatus(options, 'resolve', runtime);
}

export function executeReopenComment(
  options: ThreadStatusCommandOptions,
  runtime: CliRuntime,
): Promise<CommentThread> {
  return executeThreadStatus(options, 'reopen', runtime);
}

async function executePostModeration(
  options: PostModerationCommandOptions,
  moderation: 'hide' | 'unhide',
  runtime: CliRuntime,
): Promise<CommentPost> {
  return moderateArtifactCommentPost(
    {
      ...(await transport(options, runtime)),
      postId: commentId(options.post, 'post'),
      moderation,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeHideComment(
  options: PostModerationCommandOptions,
  runtime: CliRuntime,
): Promise<CommentPost> {
  return executePostModeration(options, 'hide', runtime);
}

export function executeUnhideComment(
  options: PostModerationCommandOptions,
  runtime: CliRuntime,
): Promise<CommentPost> {
  return executePostModeration(options, 'unhide', runtime);
}
