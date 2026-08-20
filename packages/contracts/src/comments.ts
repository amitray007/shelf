import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

import { OpaqueArtifactIdSchema, OpaqueRevisionIdSchema } from './publish.js';
import { OpaqueShareIdSchema } from './shares.js';

export type { CommentPolicy } from './shares.js';
export { CommentPolicySchema } from './shares.js';

export const CommentVisibilitySchema = Type.Union([
  Type.Literal('private'),
  Type.Literal('shared'),
]);

export const CommentAnchorSchema = Type.Object(
  {
    revisionId: OpaqueRevisionIdSchema,
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    kind: Type.Union([Type.Literal('file'), Type.Literal('range')]),
    startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    quotedText: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    contentHash: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  },
  { additionalProperties: false, $id: 'CommentAnchor' },
);

export const CommentAnchorStatusSchema = Type.Union([
  Type.Literal('exact'),
  Type.Literal('outdated'),
]);

export const CommentAuthorSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('visitor'),
      participantId: Type.String({ minLength: 1, maxLength: 128 }),
      displayName: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('actor'),
      participantId: Type.String({ minLength: 1, maxLength: 128 }),
      actorId: Type.String({ minLength: 1, maxLength: 128 }),
      displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
]);

export const CommentPostPermissionsSchema = Type.Object(
  {
    canEdit: Type.Boolean(),
    canDelete: Type.Boolean(),
    canModerate: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CommentPostPermissions' },
);

export const CommentThreadPermissionsSchema = Type.Object(
  {
    canReply: Type.Boolean(),
    canResolve: Type.Boolean(),
    canReopen: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'CommentThreadPermissions' },
);

export const CommentPostSchema = Type.Object(
  {
    postId: Type.String({ minLength: 1, maxLength: 128 }),
    threadId: Type.String({ minLength: 1, maxLength: 128 }),
    body: Type.String({ minLength: 1, maxLength: 20_000 }),
    author: CommentAuthorSchema,
    permissions: CommentPostPermissionsSchema,
    createdAt: Type.String({ format: 'date-time' }),
    editedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    deletedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    hiddenAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CommentPost' },
);

export const CommentThreadSchema = Type.Object(
  {
    threadId: Type.String({ minLength: 1, maxLength: 128 }),
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    shareId: OpaqueShareIdSchema,
    revisionId: OpaqueRevisionIdSchema,
    visibility: CommentVisibilitySchema,
    anchor: CommentAnchorSchema,
    anchorStatus: CommentAnchorStatusSchema,
    resolvedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    permissions: CommentThreadPermissionsSchema,
    posts: Type.Array(CommentPostSchema, { maxItems: 100 }),
  },
  { additionalProperties: false, $id: 'CommentThread' },
);

export const CommentThreadPageSchema = Type.Object(
  {
    items: Type.Array(CommentThreadSchema),
    nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CommentThreadPage' },
);

/** The number of recent participant threads included in batched artifact summaries. */
export const COMMENT_SUMMARY_RECENT_THREAD_LIMIT = 8;

export const CommentSummaryRecentThreadSchema = Type.Object(
  {
    threadId: Type.String({ minLength: 1, maxLength: 128 }),
    latestActivityAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false, $id: 'CommentSummaryRecentThread' },
);

export const CommentSummarySchema = Type.Object(
  {
    artifactId: OpaqueArtifactIdSchema,
    participantCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    participants: Type.Array(
      Type.Object(
        {
          participantId: Type.String({ minLength: 1, maxLength: 128 }),
          displayName: Type.String({ minLength: 1, maxLength: 128 }),
          threadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          replyCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          latestThreadId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
          latestActivityAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
          recentThreads: Type.Array(CommentSummaryRecentThreadSchema, {
            maxItems: COMMENT_SUMMARY_RECENT_THREAD_LIMIT,
          }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
    openThreadCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    openReplyCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    latestActivityAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    latestThreadId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CommentSummary' },
);

export type CommentVisibility = Static<typeof CommentVisibilitySchema>;
export type CommentAnchor = Static<typeof CommentAnchorSchema>;
export type CommentAnchorStatus = Static<typeof CommentAnchorStatusSchema>;
export type CommentAuthor = Static<typeof CommentAuthorSchema>;
export type CommentPostPermissions = Static<typeof CommentPostPermissionsSchema>;
export type CommentThreadPermissions = Static<typeof CommentThreadPermissionsSchema>;
export type CommentPost = Static<typeof CommentPostSchema>;
export type CommentThread = Static<typeof CommentThreadSchema>;
export interface CommentThreadPage {
  readonly items: readonly CommentThread[];
  readonly nextCursor: string | null;
}
export type CommentSummary = Static<typeof CommentSummarySchema>;

export function isCommentAnchor(value: unknown): value is CommentAnchor {
  return Check(CommentAnchorSchema, value);
}

export function isCommentPost(value: unknown): value is CommentPost {
  return Check(CommentPostSchema, value);
}

export function isCommentThread(value: unknown): value is CommentThread {
  return Check(CommentThreadSchema, value);
}
