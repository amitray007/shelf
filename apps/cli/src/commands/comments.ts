import type { CommentPost, CommentThread } from '@shelf/contracts';

import {
  listArtifactComments,
  moderateArtifactCommentPost,
  replyArtifactComment,
  setArtifactCommentStatus,
} from '../client.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

interface ArtifactCommentsCommandOptions {
  url: string;
  workspace: string;
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
}

export interface ThreadStatusCommandOptions extends ArtifactCommentsCommandOptions {
  thread: string;
}

export interface PostModerationCommandOptions extends ArtifactCommentsCommandOptions {
  post: string;
}

function token(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

function workspaceId(value: string): string {
  if (value.length === 0 || value.length > 128) throw usageFailure('The workspace ID is invalid.');
  return value;
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

function commentId(value: string, label: 'thread' | 'post'): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (value.length === 0 || value.length > 128 || hasControlCharacter) {
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

function pageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw usageFailure('The comment page limit is invalid.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw usageFailure('The comment page limit must be between 1 and 50.');
  }
  return parsed;
}

function transport(options: ArtifactCommentsCommandOptions, runtime: CliRuntime) {
  return {
    installationUrl: options.url,
    workspaceId: workspaceId(options.workspace),
    artifactId: artifactId(options.artifact),
    token: token(runtime),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
  };
}

export function executeListComments(
  options: ListCommentsCommandOptions,
  runtime: CliRuntime,
): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
  const selectedRevision = revisionId(options.revision);
  const limit = pageLimit(options.limit);
  return listArtifactComments(
    {
      ...transport(options, runtime),
      ...(selectedRevision === undefined ? {} : { revisionId: selectedRevision }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(limit === undefined ? {} : { limit }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeReplyComment(
  options: ReplyCommentCommandOptions,
  runtime: CliRuntime,
): Promise<CommentPost> {
  return replyArtifactComment(
    {
      ...transport(options, runtime),
      threadId: commentId(options.thread, 'thread'),
      body: body(options.body),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

function executeThreadStatus(
  options: ThreadStatusCommandOptions,
  status: 'resolve' | 'reopen',
  runtime: CliRuntime,
): Promise<CommentThread> {
  return setArtifactCommentStatus(
    {
      ...transport(options, runtime),
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

function executePostModeration(
  options: PostModerationCommandOptions,
  moderation: 'hide' | 'unhide',
  runtime: CliRuntime,
): Promise<CommentPost> {
  return moderateArtifactCommentPost(
    {
      ...transport(options, runtime),
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
