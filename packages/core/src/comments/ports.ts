import type {
  CommentAnchor,
  CommentAnchorStatus,
  CommentAuthor,
  CommentPolicy,
  CommentSummary,
  CommentVisibility,
} from '@shelf/contracts';
import type { CommentThreadCursor, CommentThreadListScope } from './pagination.js';

export type { CommentSummary, CommentThreadPage } from '@shelf/contracts';

export type StoredCommentThreadPage = {
  readonly items: StoredCommentThread[];
  readonly nextCursor: string | null;
};

export interface StoredCommentVisitor {
  installationId: string;
  visitorKey: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredCommentPost {
  postId: string;
  threadId: string;
  body: string;
  author: CommentAuthor;
  visitorKey: string | null;
  actorId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  hiddenAt: string | null;
}

export interface StoredCommentThread {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  shareId: string;
  threadId: string;
  revisionId: string;
  visibility: CommentVisibility;
  anchor: CommentAnchor;
  anchorStatus: CommentAnchorStatus;
  resolvedAt: string | null;
  resolvedByActorId: string | null;
  createdAt: string;
  updatedAt: string;
  starterVisitorKey: string | null;
  posts: StoredCommentPost[];
}

export interface CommentAbuseMetadata {
  rotatingIpHash?: string;
  browser?: string;
  operatingSystem?: string;
  expiresAt?: string;
}

export interface UpsertCommentVisitorInput {
  installationId: string;
  visitorKey: string;
  displayName: string;
  now: string;
}

export interface CreateCommentThreadInput {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  shareId: string;
  threadId: string;
  revisionId: string;
  visibility: CommentVisibility;
  anchor: CommentAnchor;
  post: Omit<StoredCommentPost, 'threadId'>;
  abuse?: CommentAbuseMetadata;
}

export interface CreateCommentReplyInput {
  installationId: string;
  workspaceId: string;
  threadId: string;
  post: Omit<StoredCommentPost, 'threadId'>;
  abuse?: CommentAbuseMetadata;
}

export interface CommentRepository {
  upsertVisitor(input: UpsertCommentVisitorInput): Promise<StoredCommentVisitor>;
  cleanupExpiredAbuse(now: string, limit: number): Promise<number>;
  createThread(input: CreateCommentThreadInput): Promise<StoredCommentThread>;
  createReply(input: CreateCommentReplyInput): Promise<StoredCommentPost>;
  findThread(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
  }): Promise<StoredCommentThread | undefined>;
  findPost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<StoredCommentPost | undefined>;
  findPostContext(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
  }): Promise<{ post: StoredCommentPost; shareId: string } | undefined>;
  listThreads(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    cursor?: CommentThreadCursor;
    limit: number;
    scope?: CommentThreadListScope;
  }): Promise<StoredCommentThreadPage>;
  listArtifactThreads(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    cursor?: CommentThreadCursor;
    limit: number;
    scope?: CommentThreadListScope;
  }): Promise<StoredCommentThreadPage>;
  editPost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    body: string;
    editedAt: string;
  }): Promise<StoredCommentPost | undefined>;
  deletePost(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    deletedAt: string;
  }): Promise<StoredCommentPost | undefined>;
  setPostHidden(request: {
    installationId: string;
    workspaceId: string;
    postId: string;
    hiddenAt: string | null;
  }): Promise<StoredCommentPost | undefined>;
  setThreadResolved(request: {
    installationId: string;
    workspaceId: string;
    threadId: string;
    resolvedAt: string | null;
    resolvedByActorId: string | null;
  }): Promise<StoredCommentThread | undefined>;
  summarizeArtifacts(request: {
    installationId: string;
    workspaceId: string;
    artifactIds: string[];
  }): Promise<CommentSummary[]>;
}

export class CommentResolvedThreadEditError extends Error {
  constructor() {
    super('Comment posts cannot be edited while their thread is resolved.');
    this.name = 'CommentResolvedThreadEditError';
  }
}

export type CommentAuthority =
  | { kind: 'visitor'; visitorKey: string; displayName?: string }
  | { kind: 'moderator'; actorId: string; displayName?: string };

export interface CommentShareContext {
  installationId: string;
  workspaceId: string;
  artifactId: string;
  shareId: string;
  revisionId: string;
  commentPolicy: CommentPolicy;
  active: boolean;
}
