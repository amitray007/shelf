import { createHash, randomBytes } from 'node:crypto';

import type {
  CommentAnchor,
  CommentAuthor,
  CommentPolicy,
  CommentPost,
  CommentSummary,
  CommentThread,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import { shareLifecycleStatus } from '../shares/lifecycle.js';
import type { ShareRepository, StoredShare, StoredShareRevision } from '../shares/ports.js';
import {
  type CommentThreadListScope,
  commentCursorMatchesScope,
  decodeCommentThreadCursor,
  normalizeCommentPageLimit,
} from './pagination.js';
import type {
  CommentAbuseMetadata,
  CommentAuthority,
  CommentRepository,
  CreateCommentReplyInput,
  CreateCommentThreadInput,
  StoredCommentPost,
  StoredCommentThread,
} from './ports.js';

export class CommentThreadPostLimitError extends ShelfCoreError {
  constructor() {
    super('INVALID_REQUEST', 'A comment thread cannot contain more than 100 posts.', {
      retryable: false,
      details: [{ field: 'threadId', reason: 'threads are limited to 100 total posts' }],
    });
    this.name = 'CommentThreadPostLimitError';
  }
}

const OPAQUE_VISITOR_KEY = /^[A-Za-z0-9_:-]{16,512}$/u;
const BODY_MAX = 20_000;
const PATH_MAX = 2_048;
const ABUSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function commentParticipantId(kind: 'visitor' | 'actor', key: string): string {
  return `pt_${createHash('sha256').update(`participant:v1:${kind}:${key}`).digest('base64url').slice(0, 22)}`;
}

export class InvalidCommentRequestError extends ShelfCoreError {
  constructor(details: Array<{ field: string; reason: string }>) {
    super('INVALID_REQUEST', 'The comment request is invalid.', { retryable: false, details });
    this.name = 'InvalidCommentRequestError';
  }
}

export class CommentWriteDisabledError extends ShelfCoreError {
  constructor() {
    super('INVALID_REQUEST', 'Comments are disabled for this share.', { retryable: false });
    this.name = 'CommentWriteDisabledError';
  }
}

export class CommentNotFoundError extends ShelfCoreError {
  constructor() {
    super('SHARE_NOT_FOUND', 'The requested comment was not found.', { retryable: false });
    this.name = 'CommentNotFoundError';
  }
}

function defaultClock(): Date {
  return new Date();
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

function body(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > BODY_MAX) {
    throw new InvalidCommentRequestError([
      { field: 'body', reason: 'must contain 1-20000 non-whitespace characters' },
    ]);
  }
  return normalized;
}

function validateVisitorKey(authority: Extract<CommentAuthority, { kind: 'visitor' }>): void {
  if (!OPAQUE_VISITOR_KEY.test(authority.visitorKey)) {
    throw new InvalidCommentRequestError([
      { field: 'visitorKey', reason: 'must be a backend-generated visitor digest/key' },
    ]);
  }
}

function displayNameForVisitor(authority: Extract<CommentAuthority, { kind: 'visitor' }>): string {
  validateVisitorKey(authority);
  const displayName = authority.displayName?.trim() ?? '';
  if (displayName.length === 0 || displayName.length > 128) {
    throw new InvalidCommentRequestError([
      { field: 'displayName', reason: 'must contain 1-128 characters' },
    ]);
  }
  return displayName;
}

function validateVisitorMutationAuthority(
  authority: Extract<CommentAuthority, { kind: 'visitor' }>,
): void {
  validateVisitorKey(authority);
  if (authority.displayName !== undefined) displayNameForVisitor(authority);
}

function validateAnchor(anchor: CommentAnchor): void {
  if (
    anchor.path !== undefined &&
    (anchor.path.length > PATH_MAX || anchor.path.includes('\u0000'))
  ) {
    throw new InvalidCommentRequestError([{ field: 'anchor.path', reason: 'must be a safe path' }]);
  }
  if (anchor.path?.split('/').some((part) => part === '..')) {
    throw new InvalidCommentRequestError([
      { field: 'anchor.path', reason: 'must not escape the folder root' },
    ]);
  }
  if (
    anchor.quotedText !== undefined &&
    (anchor.quotedText.length === 0 || anchor.quotedText.length > 2048)
  ) {
    throw new InvalidCommentRequestError([
      { field: 'anchor.quotedText', reason: 'must contain 1-2048 characters' },
    ]);
  }
  if (anchor.contentHash !== undefined && anchor.contentHash.length > 255) {
    throw new InvalidCommentRequestError([
      { field: 'anchor.contentHash', reason: 'must contain at most 255 characters' },
    ]);
  }
  if (anchor.kind === 'file') {
    if (anchor.startLine !== undefined || anchor.endLine !== undefined) {
      throw new InvalidCommentRequestError([
        { field: 'anchor', reason: 'file anchors cannot include line ranges' },
      ]);
    }
    return;
  }
  if (
    !Number.isSafeInteger(anchor.startLine) ||
    !Number.isSafeInteger(anchor.endLine) ||
    (anchor.startLine as number) < 1 ||
    (anchor.endLine as number) < (anchor.startLine as number)
  ) {
    throw new InvalidCommentRequestError([
      { field: 'anchor', reason: 'range lines must be ordered positive integers' },
    ]);
  }
}

function abuseMetadata(
  value: CommentAbuseMetadata | undefined,
  now: Date,
): CommentAbuseMetadata | undefined {
  if (value === undefined) return undefined;
  for (const [field, candidate, max] of [
    ['rotatingIpHash', value.rotatingIpHash, 255],
    ['browser', value.browser, 128],
    ['operatingSystem', value.operatingSystem, 128],
  ] as const) {
    if (candidate !== undefined && (candidate.length === 0 || candidate.length > max)) {
      throw new InvalidCommentRequestError([
        { field: `abuse.${field}`, reason: `must contain 1-${max} characters` },
      ]);
    }
  }
  const expiry =
    value.expiresAt === undefined
      ? new Date(now.getTime() + ABUSE_RETENTION_MS)
      : new Date(value.expiresAt);
  if (!Number.isFinite(expiry.getTime())) {
    throw new InvalidCommentRequestError([
      { field: 'abuse.expiresAt', reason: 'must be a valid ISO instant' },
    ]);
  }
  if (expiry.getTime() <= now.getTime()) {
    throw new InvalidCommentRequestError([
      { field: 'abuse.expiresAt', reason: 'must be in the future' },
    ]);
  }
  const bounded = new Date(Math.min(expiry.getTime(), now.getTime() + ABUSE_RETENTION_MS));
  return { ...value, expiresAt: bounded.toISOString() };
}

function visibleTo(thread: StoredCommentThread, authority: CommentAuthority): boolean {
  if (authority.kind === 'moderator') return true;
  if (thread.visibility === 'shared') return true;
  return thread.starterVisitorKey === authority.visitorKey;
}

function outputPost(
  post: StoredCommentPost,
  authority: CommentAuthority,
  currentPolicy: CommentPolicy = 'off',
): CommentPost {
  const author: CommentAuthor =
    post.author.kind === 'visitor'
      ? {
          kind: 'visitor',
          participantId: commentParticipantId(
            'visitor',
            post.visitorKey ?? post.author.displayName,
          ),
          displayName: post.author.displayName,
        }
      : {
          kind: 'actor',
          participantId: commentParticipantId('actor', post.actorId ?? post.author.actorId),
          actorId: post.author.actorId,
        };
  return {
    postId: post.postId,
    threadId: post.threadId,
    body: post.deletedAt === null ? post.body : '[deleted]',
    author,
    permissions: {
      canEdit:
        post.deletedAt === null &&
        (authority.kind === 'moderator' ||
          (currentPolicy !== 'off' && post.visitorKey === authority.visitorKey)),
      canDelete:
        post.deletedAt === null &&
        (authority.kind === 'moderator' ||
          (currentPolicy !== 'off' && post.visitorKey === authority.visitorKey)),
      canModerate: authority.kind === 'moderator' && post.visitorKey !== null,
    },
    createdAt: post.createdAt,
    editedAt: post.editedAt,
    deletedAt: post.deletedAt,
    hiddenAt: post.hiddenAt,
  };
}

function postForAuthority(
  authority: CommentAuthority,
  postId: string,
  commentBody: string,
  createdAt: string,
): Omit<StoredCommentPost, 'threadId'> {
  return {
    postId,
    body: commentBody,
    author:
      authority.kind === 'visitor'
        ? {
            kind: 'visitor',
            participantId: commentParticipantId('visitor', authority.visitorKey),
            displayName: displayNameForVisitor(authority),
          }
        : {
            kind: 'actor',
            participantId: commentParticipantId('actor', authority.actorId),
            actorId: authority.actorId,
          },
    visitorKey: authority.kind === 'visitor' ? authority.visitorKey : null,
    actorId: authority.kind === 'moderator' ? authority.actorId : null,
    createdAt,
    editedAt: null,
    deletedAt: null,
    hiddenAt: null,
  };
}

function outputThread(
  thread: StoredCommentThread,
  authority: CommentAuthority,
  currentRevisionId?: string,
  currentPolicy: CommentPolicy = 'off',
): CommentThread {
  const canResolve =
    thread.resolvedAt === null &&
    (authority.kind === 'moderator' ||
      (authority.kind === 'visitor' &&
        currentPolicy !== 'off' &&
        thread.starterVisitorKey === authority.visitorKey));
  const canReopen = authority.kind === 'moderator' && thread.resolvedAt !== null;
  return {
    threadId: thread.threadId,
    workspaceId: thread.workspaceId,
    artifactId: thread.artifactId,
    shareId: thread.shareId,
    revisionId: thread.revisionId,
    visibility: thread.visibility,
    anchor: thread.anchor,
    anchorStatus:
      currentRevisionId === undefined || currentRevisionId === thread.revisionId
        ? 'exact'
        : 'outdated',
    resolvedAt: thread.resolvedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    permissions: {
      canReply:
        thread.resolvedAt === null && currentPolicy !== 'off' && visibleTo(thread, authority),
      canResolve,
      canReopen,
    },
    posts: thread.posts
      .filter((post) => authority.kind === 'moderator' || post.hiddenAt === null)
      .map((post) => outputPost(post, authority, currentPolicy)),
  };
}

function scopedRevision(share: StoredShare, revision: StoredShareRevision): boolean {
  return (
    revision.installationId === share.installationId &&
    revision.workspaceId === share.workspaceId &&
    revision.artifactId === share.artifactId
  );
}

async function loadShare(
  dependencies: { shares: ShareRepository },
  shareId: string,
): Promise<StoredShare> {
  let share: StoredShare | undefined;
  try {
    share = await dependencies.shares.findShare(shareId);
  } catch (error) {
    throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment share lookup failed.', error);
  }
  if (share === undefined) throw new CommentNotFoundError();
  return share;
}

async function loadShareOptional(
  dependencies: { shares: ShareRepository },
  shareId: string,
): Promise<StoredShare | undefined> {
  try {
    return await dependencies.shares.findShare(shareId);
  } catch (error) {
    throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment share lookup failed.', error);
  }
}

async function ensureWriteShare(
  dependencies: { shares: ShareRepository },
  shareId: string,
  now: Date,
): Promise<StoredShare> {
  const share = await loadShare(dependencies, shareId);
  if (shareLifecycleStatus(share, now) !== 'active') throw new CommentNotFoundError();
  if ((share.commentPolicy ?? 'off') === 'off') throw new CommentWriteDisabledError();
  return share;
}

async function ensureActiveShare(
  dependencies: { shares: ShareRepository },
  shareId: string,
  now: Date,
): Promise<StoredShare> {
  const share = await loadShare(dependencies, shareId);
  if (shareLifecycleStatus(share, now) !== 'active') throw new CommentNotFoundError();
  return share;
}

export function createCommentService(dependencies: {
  comments: CommentRepository;
  shares: ShareRepository;
  clock?: () => Date;
  generateThreadId?: () => string;
  generatePostId?: () => string;
}) {
  const clock = dependencies.clock ?? defaultClock;
  const generateThreadId = dependencies.generateThreadId ?? (() => id('thd'));
  const generatePostId = dependencies.generatePostId ?? (() => id('pst'));

  async function prepareVisitor(
    authority: CommentAuthority,
    installationId: string,
    now: string,
  ): Promise<void> {
    if (authority.kind === 'visitor') {
      const displayName = displayNameForVisitor(authority);
      try {
        await dependencies.comments.upsertVisitor({
          installationId,
          visitorKey: authority.visitorKey,
          displayName,
          now,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment visitor persistence failed.', error);
      }
    }
  }

  async function checkRevision(share: StoredShare, revisionId: string): Promise<void> {
    let revision: StoredShareRevision | undefined;
    try {
      revision = await dependencies.shares.findRevisionForShare(revisionId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment revision lookup failed.', error);
    }
    if (
      revision === undefined ||
      revision.revision.revisionId !== revisionId ||
      !scopedRevision(share, revision)
    ) {
      throw new InvalidCommentRequestError([
        { field: 'revisionId', reason: 'must belong to the share artifact and tenant' },
      ]);
    }
  }

  return {
    async createThread(request: {
      installationId: string;
      workspaceId: string;
      shareId: string;
      revisionId: string;
      anchor: CommentAnchor;
      authority: CommentAuthority;
      body: string;
      abuse?: CreateCommentThreadInput['abuse'];
    }): Promise<CommentThread> {
      const normalizedBody = body(request.body);
      if (request.authority.kind === 'visitor') displayNameForVisitor(request.authority);
      const now = clock().toISOString();
      const share = await ensureWriteShare(dependencies, request.shareId, new Date(now));
      if (
        share.installationId !== request.installationId ||
        share.workspaceId !== request.workspaceId
      ) {
        throw new CommentNotFoundError();
      }
      validateAnchor(request.anchor);
      await checkRevision(share, request.revisionId);
      await prepareVisitor(request.authority, request.installationId, now);
      const post = postForAuthority(request.authority, generatePostId(), normalizedBody, now);
      let created: StoredCommentThread;
      try {
        created = await dependencies.comments.createThread({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          artifactId: share.artifactId,
          shareId: share.shareId,
          threadId: generateThreadId(),
          revisionId: request.revisionId,
          visibility: share.commentPolicy === 'shared' ? 'shared' : 'private',
          anchor: request.anchor,
          post,
          ...(request.abuse === undefined
            ? {}
            : { abuse: abuseMetadata(request.abuse, new Date(now)) as CommentAbuseMetadata }),
        });
      } catch (error) {
        if (error instanceof CommentThreadPostLimitError) throw error;
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment thread persistence failed.', error);
      }
      return outputThread(created, request.authority, undefined, share.commentPolicy ?? 'off');
    },

    async createReply(request: {
      installationId: string;
      workspaceId: string;
      threadId: string;
      shareId?: string;
      authority: CommentAuthority;
      body: string;
      abuse?: CreateCommentReplyInput['abuse'];
    }): Promise<CommentPost> {
      const normalizedBody = body(request.body);
      if (request.authority.kind === 'visitor') displayNameForVisitor(request.authority);
      let thread: StoredCommentThread | undefined;
      try {
        thread = await dependencies.comments.findThread(request);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment thread lookup failed.', error);
      }
      if (thread === undefined) throw new CommentNotFoundError();
      if (request.authority.kind === 'visitor' && request.shareId === undefined) {
        throw new InvalidCommentRequestError([
          { field: 'shareId', reason: 'is required for visitor writes' },
        ]);
      }
      if (request.shareId !== undefined && request.shareId !== thread.shareId) {
        throw new CommentNotFoundError();
      }
      if (thread.resolvedAt !== null) {
        throw new InvalidCommentRequestError([
          { field: 'threadId', reason: 'resolved threads must be reopened before replying' },
        ]);
      }
      const share = await ensureActiveShare(dependencies, thread.shareId, clock());
      if (
        share.installationId !== request.installationId ||
        share.workspaceId !== request.workspaceId ||
        !visibleTo(thread, request.authority)
      ) {
        throw new CommentNotFoundError();
      }
      if (request.authority.kind === 'visitor' && (share.commentPolicy ?? 'off') === 'off') {
        throw new CommentWriteDisabledError();
      }
      const now = clock().toISOString();
      await prepareVisitor(request.authority, request.installationId, now);
      const post = postForAuthority(request.authority, generatePostId(), normalizedBody, now);
      let created: StoredCommentPost;
      try {
        created = await dependencies.comments.createReply({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          threadId: thread.threadId,
          post,
          ...(request.abuse === undefined
            ? {}
            : { abuse: abuseMetadata(request.abuse, new Date(now)) as CommentAbuseMetadata }),
        });
      } catch (error) {
        if (error instanceof CommentThreadPostLimitError) throw error;
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment reply persistence failed.', error);
      }
      return outputPost(created, request.authority, share.commentPolicy ?? 'off');
    },

    async listThreads(request: {
      installationId: string;
      workspaceId: string;
      shareId: string;
      authority: CommentAuthority;
      currentRevisionId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
      const share = await loadShare(dependencies, request.shareId);
      if (
        share.installationId !== request.installationId ||
        share.workspaceId !== request.workspaceId ||
        shareLifecycleStatus(share, clock()) !== 'active'
      ) {
        throw new CommentNotFoundError();
      }
      if (request.authority.kind === 'visitor') validateVisitorKey(request.authority);
      const scope: CommentThreadListScope = {
        kind: 'share',
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        shareId: request.shareId,
      };
      const cursor =
        request.cursor === undefined ? undefined : decodeCommentThreadCursor(request.cursor);
      if (
        request.cursor !== undefined &&
        (cursor === undefined || !commentCursorMatchesScope(cursor, scope))
      ) {
        throw new InvalidCommentRequestError([
          { field: 'cursor', reason: 'is invalid for this share' },
        ]);
      }
      const limit = normalizeCommentPageLimit(request.limit);
      let page: Awaited<ReturnType<CommentRepository['listThreads']>>;
      try {
        page = await dependencies.comments.listThreads({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          shareId: request.shareId,
          limit,
          scope,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment thread listing failed.', error);
      }
      return {
        items: page.items
          .filter((thread) => visibleTo(thread, request.authority))
          .map((thread) =>
            outputThread(
              thread,
              request.authority,
              request.currentRevisionId,
              share.commentPolicy ?? 'off',
            ),
          ),
        nextCursor: page.nextCursor,
      };
    },

    async listArtifactThreads(request: {
      installationId: string;
      workspaceId: string;
      artifactId: string;
      authority: CommentAuthority;
      currentRevisionId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
      if (request.authority.kind !== 'moderator') {
        throw new CommentNotFoundError();
      }
      const scope: CommentThreadListScope = {
        kind: 'artifact',
        installationId: request.installationId,
        workspaceId: request.workspaceId,
        artifactId: request.artifactId,
      };
      const cursor =
        request.cursor === undefined ? undefined : decodeCommentThreadCursor(request.cursor);
      if (
        request.cursor !== undefined &&
        (cursor === undefined || !commentCursorMatchesScope(cursor, scope))
      ) {
        throw new InvalidCommentRequestError([
          { field: 'cursor', reason: 'is invalid for this artifact' },
        ]);
      }
      const limit = normalizeCommentPageLimit(request.limit);
      let page: Awaited<ReturnType<CommentRepository['listArtifactThreads']>>;
      try {
        page = await dependencies.comments.listArtifactThreads({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          artifactId: request.artifactId,
          limit,
          scope,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Artifact comment listing failed.', error);
      }
      const shareIds = [...new Set(page.items.map((thread) => thread.shareId))];
      let shares: Array<readonly [string, StoredShare | undefined]>;
      try {
        if (dependencies.shares.findSharesByIds !== undefined) {
          const found = await dependencies.shares.findSharesByIds({
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            shareIds,
          });
          if (
            found.some(
              (share) =>
                share.installationId !== request.installationId ||
                share.workspaceId !== request.workspaceId ||
                !shareIds.includes(share.shareId),
            )
          ) {
            throw new Error('Share repository crossed the requested tenant or share scope.');
          }
          const byId = new Map(found.map((share) => [share.shareId, share]));
          shares = shareIds.map((shareId) => [shareId, byId.get(shareId)] as const);
        } else {
          shares = await Promise.all(
            shareIds.map(
              async (shareId) => [shareId, await loadShareOptional(dependencies, shareId)] as const,
            ),
          );
        }
      } catch (error) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Artifact comment share lookup failed.',
          error,
        );
      }
      if (
        shares.some(
          ([, share]) =>
            share !== undefined &&
            (share.installationId !== request.installationId ||
              share.workspaceId !== request.workspaceId),
        )
      ) {
        throw boundaryFailure(
          'SERVICE_UNAVAILABLE',
          'Artifact comment share lookup returned invalid scope.',
          new Error('Share repository crossed the requested tenant scope.'),
        );
      }
      const policyByShareId = new Map(
        shares.map(([shareId, share]) => [shareId, share?.commentPolicy ?? ('off' as const)]),
      );
      return {
        items: page.items.map((thread) =>
          outputThread(
            thread,
            request.authority,
            request.currentRevisionId,
            policyByShareId.get(thread.shareId) ?? 'off',
          ),
        ),
        nextCursor: page.nextCursor,
      };
    },

    async resolveThread(request: {
      installationId: string;
      workspaceId: string;
      threadId: string;
      authority: CommentAuthority;
      shareId?: string;
      reopen?: boolean;
    }): Promise<CommentThread> {
      if (request.authority.kind === 'visitor') validateVisitorMutationAuthority(request.authority);
      let thread: StoredCommentThread | undefined;
      try {
        thread = await dependencies.comments.findThread(request);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment thread lookup failed.', error);
      }
      if (thread === undefined || !visibleTo(thread, request.authority)) {
        throw new CommentNotFoundError();
      }
      if (request.authority.kind === 'visitor' && request.shareId === undefined) {
        throw new InvalidCommentRequestError([
          { field: 'shareId', reason: 'is required for visitor writes' },
        ]);
      }
      if (request.shareId !== undefined && request.shareId !== thread.shareId) {
        throw new CommentNotFoundError();
      }
      const share =
        request.authority.kind === 'visitor'
          ? await ensureWriteShare(dependencies, thread.shareId, clock())
          : await ensureActiveShare(dependencies, thread.shareId, clock());
      if (
        share.installationId !== request.installationId ||
        share.workspaceId !== request.workspaceId
      ) {
        throw new CommentNotFoundError();
      }
      if (request.reopen && request.authority.kind !== 'moderator') {
        throw new InvalidCommentRequestError([
          { field: 'authority', reason: 'moderators may reopen' },
        ]);
      }
      if (
        !request.reopen &&
        request.authority.kind === 'visitor' &&
        thread.starterVisitorKey !== request.authority.visitorKey
      ) {
        throw new CommentNotFoundError();
      }
      if (request.authority.kind === 'visitor' && request.authority.displayName !== undefined) {
        await prepareVisitor(request.authority, request.installationId, clock().toISOString());
      }
      const now = clock().toISOString();
      let resolved: StoredCommentThread | undefined;
      try {
        resolved = await dependencies.comments.setThreadResolved({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          threadId: request.threadId,
          resolvedAt: request.reopen ? null : now,
          resolvedByActorId:
            request.authority.kind === 'moderator' ? request.authority.actorId : null,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment thread update failed.', error);
      }
      if (resolved === undefined) throw new CommentNotFoundError();
      return outputThread(resolved, request.authority, undefined, share?.commentPolicy ?? 'off');
    },

    async editPost(request: {
      installationId: string;
      workspaceId: string;
      postId: string;
      authority: CommentAuthority;
      shareId?: string;
      body: string;
    }): Promise<CommentPost> {
      const normalizedBody = body(request.body);
      let share: StoredShare | undefined;
      if (request.authority.kind === 'visitor') {
        validateVisitorMutationAuthority(request.authority);
        if (request.shareId === undefined) {
          throw new InvalidCommentRequestError([
            { field: 'shareId', reason: 'is required for visitor writes' },
          ]);
        }
        let context: Awaited<ReturnType<CommentRepository['findPostContext']>>;
        try {
          context = await dependencies.comments.findPostContext({
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            postId: request.postId,
          });
        } catch (error) {
          throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment post lookup failed.', error);
        }
        if (context === undefined) throw new CommentNotFoundError();
        if (
          request.shareId !== context.shareId ||
          context.post.visitorKey !== request.authority.visitorKey
        )
          throw new CommentNotFoundError();
        share = await ensureWriteShare(dependencies, context.shareId, clock());
        if (
          share.installationId !== request.installationId ||
          share.workspaceId !== request.workspaceId
        )
          throw new CommentNotFoundError();
        if (request.authority.displayName !== undefined) {
          await prepareVisitor(request.authority, request.installationId, clock().toISOString());
        }
      }
      let updated: StoredCommentPost | undefined;
      try {
        updated = await dependencies.comments.editPost({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          postId: request.postId,
          body: normalizedBody,
          editedAt: clock().toISOString(),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment post update failed.', error);
      }
      if (updated === undefined) throw new CommentNotFoundError();
      return outputPost(updated, request.authority, share?.commentPolicy ?? 'off');
    },

    async deletePost(request: {
      installationId: string;
      workspaceId: string;
      postId: string;
      authority: CommentAuthority;
      shareId?: string;
    }): Promise<CommentPost> {
      let share: StoredShare | undefined;
      if (request.authority.kind === 'visitor') {
        validateVisitorMutationAuthority(request.authority);
        if (request.shareId === undefined) {
          throw new InvalidCommentRequestError([
            { field: 'shareId', reason: 'is required for visitor writes' },
          ]);
        }
        let context: Awaited<ReturnType<CommentRepository['findPostContext']>>;
        try {
          context = await dependencies.comments.findPostContext({
            installationId: request.installationId,
            workspaceId: request.workspaceId,
            postId: request.postId,
          });
        } catch (error) {
          throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment post lookup failed.', error);
        }
        if (context === undefined) throw new CommentNotFoundError();
        if (
          request.shareId !== context.shareId ||
          context.post.visitorKey !== request.authority.visitorKey
        )
          throw new CommentNotFoundError();
        share = await ensureWriteShare(dependencies, context.shareId, clock());
        if (
          share.installationId !== request.installationId ||
          share.workspaceId !== request.workspaceId
        )
          throw new CommentNotFoundError();
        if (request.authority.displayName !== undefined) {
          await prepareVisitor(request.authority, request.installationId, clock().toISOString());
        }
      }
      let deleted: StoredCommentPost | undefined;
      try {
        deleted = await dependencies.comments.deletePost({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          postId: request.postId,
          deletedAt: clock().toISOString(),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment post deletion failed.', error);
      }
      if (deleted === undefined) throw new CommentNotFoundError();
      return outputPost(deleted, request.authority, share?.commentPolicy ?? 'off');
    },

    async moderatePost(request: {
      installationId: string;
      workspaceId: string;
      postId: string;
      actorId: string;
      hidden: boolean;
    }): Promise<CommentPost> {
      let updated: StoredCommentPost | undefined;
      try {
        updated = await dependencies.comments.setPostHidden({
          installationId: request.installationId,
          workspaceId: request.workspaceId,
          postId: request.postId,
          hiddenAt: request.hidden ? clock().toISOString() : null,
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment post moderation failed.', error);
      }
      if (updated === undefined) throw new CommentNotFoundError();
      return outputPost(updated, { kind: 'moderator', actorId: request.actorId });
    },

    async summarizeArtifacts(request: {
      installationId: string;
      workspaceId: string;
      artifactIds: string[];
    }): Promise<CommentSummary[]> {
      try {
        return await dependencies.comments.summarizeArtifacts(request);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Comment summary lookup failed.', error);
      }
    },
  };
}
