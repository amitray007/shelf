import { createHmac } from 'node:crypto';

import {
  type CommentAnchor,
  CommentAnchorSchema,
  type CommentPolicy,
  CommentPolicySchema,
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  OpaqueShareIdSchema,
  PUBLISH_OPERATION,
  PublicShareCodeSchema,
  READ_REVISION_OPERATION,
} from '@shelf/contracts';
import {
  CommentNotFoundError,
  createCommentService,
  InvalidCommentRequestError,
  type ResolvedStoredShare,
  type StoredShare,
  shareLifecycleStatus,
} from '@shelf/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Static, type TSchema, Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';
import { createAuthenticatedShareLifecycle } from '../share-lifecycle.js';

const VisitorTokenSchema = Type.String({
  minLength: 32,
  maxLength: 4096,
  pattern: '^[A-Za-z0-9_-]+$',
});
const ViewerTokenSchema = Type.String({
  minLength: 24,
  maxLength: 4096,
  pattern: '^[A-Za-z0-9._-]+$',
});
const DisplayNameSchema = Type.String({ minLength: 1, maxLength: 128 });
const CommentBodySchema = Type.String({ minLength: 1, maxLength: 20_000 });
const ProtectedQueryBodySchema = Type.Object(
  {
    token: ViewerTokenSchema,
    visitorToken: Type.Optional(VisitorTokenSchema),
    currentRevisionId: Type.Optional(OpaqueRevisionIdSchema),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
const PublicQueryBodySchema = Type.Object(
  {
    visitorToken: Type.Optional(VisitorTokenSchema),
    currentRevisionId: Type.Optional(OpaqueRevisionIdSchema),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
const ProtectedThreadBodySchema = Type.Object(
  {
    token: ViewerTokenSchema,
    visitorToken: VisitorTokenSchema,
    displayName: DisplayNameSchema,
    revisionId: OpaqueRevisionIdSchema,
    anchor: CommentAnchorSchema,
    body: CommentBodySchema,
  },
  { additionalProperties: false },
);
const PublicThreadBodySchema = Type.Object(
  {
    visitorToken: VisitorTokenSchema,
    displayName: DisplayNameSchema,
    revisionId: OpaqueRevisionIdSchema,
    anchor: CommentAnchorSchema,
    body: CommentBodySchema,
  },
  { additionalProperties: false },
);
const ProtectedReplyBodySchema = Type.Object(
  {
    token: ViewerTokenSchema,
    visitorToken: VisitorTokenSchema,
    displayName: DisplayNameSchema,
    body: CommentBodySchema,
  },
  { additionalProperties: false },
);
const PublicReplyBodySchema = Type.Object(
  {
    visitorToken: VisitorTokenSchema,
    displayName: DisplayNameSchema,
    body: CommentBodySchema,
  },
  { additionalProperties: false },
);
const ProtectedThreadMutationBodySchema = Type.Object(
  {
    token: ViewerTokenSchema,
    visitorToken: VisitorTokenSchema,
    displayName: Type.Optional(DisplayNameSchema),
    status: Type.Union([Type.Literal('resolve'), Type.Literal('reopen')]),
  },
  { additionalProperties: false },
);
const PublicThreadMutationBodySchema = Type.Object(
  {
    visitorToken: VisitorTokenSchema,
    displayName: Type.Optional(DisplayNameSchema),
    status: Type.Union([Type.Literal('resolve'), Type.Literal('reopen')]),
  },
  { additionalProperties: false },
);
const ProtectedPostMutationBodySchema = Type.Object(
  {
    token: ViewerTokenSchema,
    visitorToken: VisitorTokenSchema,
    displayName: Type.Optional(DisplayNameSchema),
    action: Type.Optional(Type.Union([Type.Literal('edit'), Type.Literal('delete')])),
    deleted: Type.Optional(Type.Boolean()),
    body: Type.Optional(CommentBodySchema),
  },
  { additionalProperties: false },
);
const PublicPostMutationBodySchema = Type.Object(
  {
    visitorToken: VisitorTokenSchema,
    displayName: Type.Optional(DisplayNameSchema),
    action: Type.Optional(Type.Union([Type.Literal('edit'), Type.Literal('delete')])),
    deleted: Type.Optional(Type.Boolean()),
    body: Type.Optional(CommentBodySchema),
  },
  { additionalProperties: false },
);
const ArtifactPostMutationBodySchema = Type.Union([
  Type.Object(
    { moderation: Type.Union([Type.Literal('hide'), Type.Literal('unhide')]) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('edit'), body: CommentBodySchema },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal('delete') }, { additionalProperties: false }),
]);
const ArtifactCommentsParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
  },
  { additionalProperties: false },
);
const ArtifactThreadParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    threadId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
const ArtifactPostParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
    postId: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);
const WorkspaceShareParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    shareId: OpaqueShareIdSchema,
  },
  { additionalProperties: false },
);
const ShareParamsSchema = Type.Object(
  { shareId: OpaqueShareIdSchema },
  { additionalProperties: false },
);
const PublicParamsSchema = Type.Object(
  { publicCode: PublicShareCodeSchema },
  { additionalProperties: false },
);
const ThreadIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const ProtectedThreadParamsSchema = Type.Object(
  { shareId: OpaqueShareIdSchema, threadId: ThreadIdSchema },
  { additionalProperties: false },
);
const ProtectedPostParamsSchema = Type.Object(
  { shareId: OpaqueShareIdSchema, postId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const PublicThreadParamsSchema = Type.Object(
  { publicCode: PublicShareCodeSchema, threadId: ThreadIdSchema },
  { additionalProperties: false },
);
const PublicPostParamsSchema = Type.Object(
  { publicCode: PublicShareCodeSchema, postId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const CurrentRevisionQuerySchema = Type.Object(
  {
    currentRevisionId: Type.Optional(OpaqueRevisionIdSchema),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);
const SummaryBodySchema = Type.Object(
  {
    artifactIds: Type.Array(OpaqueArtifactIdSchema, {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
const PolicyBodySchema = Type.Object(
  {
    commentPolicy: CommentPolicySchema,
  },
  { additionalProperties: false },
);

const publicHeaders = {
  'Cache-Control': { type: 'string' },
  'Referrer-Policy': { type: 'string' },
  'X-Content-Type-Options': { type: 'string' },
  'X-Robots-Tag': { type: 'string' },
};
const errors = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};
const anonymousErrors = {
  400: { ...Type.Ref('ErrorEnvelope'), headers: publicHeaders },
  404: { ...Type.Ref('ErrorEnvelope'), headers: publicHeaders },
  500: { ...Type.Ref('ErrorEnvelope'), headers: publicHeaders },
  503: { ...Type.Ref('ErrorEnvelope'), headers: publicHeaders },
};

type CommentService = ReturnType<typeof createCommentService>;

function hmac(key: string | Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

function visitorKey(key: string | Uint8Array, installationId: string, token: string): string {
  return `visitor_${hmac(key, `visitor:v1:${installationId}:${token}`)}`;
}

function anonymousKey(key: string | Uint8Array, installationId: string): string {
  return `visitor_${hmac(key, `anonymous:v1:${installationId}`)}`;
}

function browserFamily(value: string | undefined): string {
  const ua = value ?? '';
  if (/edg\//iu.test(ua)) return 'edge';
  if (/chrome\//iu.test(ua)) return 'chrome';
  if (/firefox\//iu.test(ua)) return 'firefox';
  if (/safari\//iu.test(ua)) return 'safari';
  if (/curl\//iu.test(ua)) return 'curl';
  return 'other';
}

function operatingSystem(value: string | undefined): string {
  const ua = value ?? '';
  if (/android/iu.test(ua)) return 'android';
  if (/iphone|ipad|ios/iu.test(ua)) return 'ios';
  if (/windows/iu.test(ua)) return 'windows';
  if (/mac os/iu.test(ua)) return 'macos';
  if (/linux/iu.test(ua)) return 'linux';
  return 'other';
}

function abuseMetadata(
  dependencies: ShelfAppDependencies,
  request: FastifyRequest,
): { rotatingIpHash: string; browser: string; operatingSystem: string; expiresAt: string } {
  const now = dependencies.shareClock?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);
  return {
    rotatingIpHash: hmac(dependencies.privacyKey, `ip:v1:${day}:${request.ip}`),
    browser: browserFamily(request.headers['user-agent']),
    operatingSystem: operatingSystem(request.headers['user-agent']),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}

function commentPage(page: { items: unknown; nextCursor: string | null }): {
  items: unknown;
  nextCursor: string | null;
} {
  return { items: page.items, nextCursor: page.nextCursor };
}

function viewerToken(dependencies: ShelfAppDependencies, shareId: string, token: string): void {
  const claims = dependencies.viewerSessionTokenCodec.verify(token, {
    now: dependencies.shareClock?.() ?? new Date(),
    shareId,
  });
  if (claims === undefined) throw new CommentNotFoundError();
}

async function protectedShare(
  dependencies: ShelfAppDependencies,
  shareId: string,
  token: string,
): Promise<ResolvedStoredShare> {
  viewerToken(dependencies, shareId, token);
  const resolved = await dependencies.shareRepository.resolveShareTarget(shareId);
  if (resolved === undefined) throw new CommentNotFoundError();
  const share = resolved.share;
  if (
    share.accessType !== 'protected' ||
    shareLifecycleStatus(share, dependencies.shareClock?.() ?? new Date()) !== 'active'
  )
    throw new CommentNotFoundError();
  return resolved;
}

async function publicShare(
  dependencies: ShelfAppDependencies,
  publicCode: string,
): Promise<ResolvedStoredShare> {
  const resolved = await dependencies.shareRepository.resolvePublicShareTarget(publicCode);
  if (
    resolved === undefined ||
    resolved.share.accessType !== 'public' ||
    shareLifecycleStatus(resolved.share, dependencies.shareClock?.() ?? new Date()) !== 'active'
  ) {
    throw new CommentNotFoundError();
  }
  return resolved;
}

function currentRevision(resolved: ResolvedStoredShare): string {
  return resolved.revision.revision.revisionId;
}

export async function registerCommentRoutes(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
): Promise<void> {
  const service: CommentService = createCommentService({
    comments: dependencies.commentRepository,
    shares: dependencies.shareRepository,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });
  const lifecycle = createAuthenticatedShareLifecycle(dependencies);

  type AnonymousContext = {
    resolved: ResolvedStoredShare;
    share: StoredShare;
    installationId: string;
    workspaceId: string;
    shareId: string;
  };

  async function protectedContext(shareId: string, token: string): Promise<AnonymousContext> {
    const resolved = await protectedShare(dependencies, shareId, token);
    const share = resolved.share;
    return {
      resolved,
      share,
      installationId: share.installationId,
      workspaceId: share.workspaceId,
      shareId: share.shareId,
    };
  }

  async function publicContext(publicCode: string): Promise<AnonymousContext> {
    const resolved = await publicShare(dependencies, publicCode);
    return {
      resolved,
      share: resolved.share,
      installationId: resolved.share.installationId,
      workspaceId: resolved.share.workspaceId,
      shareId: resolved.share.shareId,
    };
  }

  async function ensureThreadArtifact(
    installationId: string,
    workspaceId: string,
    artifactId: string,
    threadId: string,
  ): Promise<void> {
    const thread = await dependencies.commentRepository.findThread({
      installationId,
      workspaceId,
      threadId,
    });
    if (thread === undefined || thread.artifactId !== artifactId) throw new CommentNotFoundError();
  }

  async function ensurePostArtifact(
    installationId: string,
    workspaceId: string,
    artifactId: string,
    postId: string,
  ): Promise<void> {
    const post = await dependencies.commentRepository.findPost({
      installationId,
      workspaceId,
      postId,
    });
    if (post === undefined) throw new CommentNotFoundError();
    await ensureThreadArtifact(installationId, workspaceId, artifactId, post.threadId);
  }

  function visitorAuthority(
    installationId: string,
    token: string | undefined,
    displayName?: string,
  ) {
    return {
      kind: 'visitor' as const,
      visitorKey:
        token === undefined
          ? anonymousKey(dependencies.privacyKey, installationId)
          : visitorKey(dependencies.privacyKey, installationId, token),
      ...(displayName === undefined ? {} : { displayName }),
    };
  }

  async function listAnonymous(
    context: AnonymousContext,
    body: { visitorToken?: string; cursor?: string; limit?: number },
  ) {
    const currentRevisionId = currentRevision(context.resolved);
    const items = await service.listThreads({
      installationId: context.installationId,
      workspaceId: context.workspaceId,
      shareId: context.shareId,
      currentRevisionId,
      ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
      ...(body.limit === undefined ? {} : { limit: body.limit }),
      authority: visitorAuthority(context.installationId, body.visitorToken),
    });
    return commentPage(items);
  }

  async function registerAnonymous(
    prefix: string,
    paramsSchema: TSchema,
    bodySchemas: {
      query: object;
      thread: object;
      reply: object;
      threadMutation: object;
      postMutation: object;
    },
    kind: 'protected' | 'public',
  ) {
    const errorsForRoute = anonymousErrors;
    const threadParamsSchema =
      kind === 'protected' ? ProtectedThreadParamsSchema : PublicThreadParamsSchema;
    const postParamsSchema =
      kind === 'protected' ? ProtectedPostParamsSchema : PublicPostParamsSchema;
    const getContext = async (params: Record<string, string>, body: Record<string, unknown>) =>
      kind === 'protected'
        ? protectedContext(params.shareId as string, body.token as string)
        : publicContext(params.publicCode as string);

    app.post(
      `${prefix}/comments/query`,
      {
        schema: {
          operationId: `${kind}ShareCommentQueryV1`,
          params: paramsSchema,
          body: bodySchemas.query,
          response: {
            200: Type.Ref('CommentThreadPage'),
            ...errorsForRoute,
          },
        },
      },
      async (request) => {
        const params = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown>;
        const context = await getContext(params, body);
        return listAnonymous(
          context,
          body as { visitorToken?: string; cursor?: string; limit?: number },
        );
      },
    );

    app.post(
      `${prefix}/comments/threads`,
      {
        schema: {
          operationId: `${kind}ShareCommentThreadCreateV1`,
          params: paramsSchema,
          body: bodySchemas.thread,
          response: { 201: Type.Ref('CommentThread'), ...errorsForRoute },
        },
      },
      async (request, reply) => {
        const params = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown>;
        const context = await getContext(params, body);
        if (body.revisionId !== context.resolved.revision.revision.revisionId) {
          throw new InvalidCommentRequestError([
            { field: 'revisionId', reason: 'must match the revision rendered by the shared link' },
          ]);
        }
        const token = body.visitorToken as string;
        const result = await service.createThread({
          installationId: context.installationId,
          workspaceId: context.workspaceId,
          shareId: context.shareId,
          revisionId: body.revisionId as string,
          anchor: body.anchor as CommentAnchor,
          authority: visitorAuthority(context.installationId, token, body.displayName as string),
          body: body.body as string,
          abuse: abuseMetadata(dependencies, request),
        });
        return reply.status(201).send(result);
      },
    );

    app.post(
      `${prefix}/comments/threads/:threadId/replies`,
      {
        schema: {
          operationId: `${kind}ShareCommentReplyCreateV1`,
          params: threadParamsSchema,
          body: bodySchemas.reply,
          response: { 201: Type.Ref('CommentPost'), ...errorsForRoute },
        },
      },
      async (request, reply) => {
        const params = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown>;
        const context = await getContext(params, body);
        const result = await service.createReply({
          installationId: context.installationId,
          workspaceId: context.workspaceId,
          threadId: params.threadId as string,
          shareId: context.shareId,
          authority: visitorAuthority(
            context.installationId,
            body.visitorToken as string,
            body.displayName as string,
          ),
          body: body.body as string,
          abuse: abuseMetadata(dependencies, request),
        });
        return reply.status(201).send(result);
      },
    );

    app.patch(
      `${prefix}/comments/threads/:threadId`,
      {
        schema: {
          operationId: `${kind}ShareCommentThreadMutationV1`,
          params: threadParamsSchema,
          body: bodySchemas.threadMutation,
          response: { 200: Type.Ref('CommentThread'), ...errorsForRoute },
        },
      },
      async (request) => {
        const params = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown>;
        const context = await getContext(params, body);
        return service.resolveThread({
          installationId: context.installationId,
          workspaceId: context.workspaceId,
          threadId: params.threadId as string,
          shareId: context.shareId,
          reopen: body.status === 'reopen',
          authority: visitorAuthority(
            context.installationId,
            body.visitorToken as string,
            body.displayName as string,
          ),
        });
      },
    );

    app.patch(
      `${prefix}/comments/posts/:postId`,
      {
        schema: {
          operationId: `${kind}ShareCommentPostMutationV1`,
          params: postParamsSchema,
          body: bodySchemas.postMutation,
          response: { 200: Type.Ref('CommentPost'), ...errorsForRoute },
        },
      },
      async (request) => {
        const params = request.params as Record<string, string>;
        const body = request.body as Record<string, unknown>;
        const context = await getContext(params, body);
        const authority = visitorAuthority(
          context.installationId,
          body.visitorToken as string,
          body.displayName as string,
        );
        if (body.action === 'delete' || body.deleted === true) {
          return service.deletePost({
            installationId: context.installationId,
            workspaceId: context.workspaceId,
            postId: params.postId as string,
            shareId: context.shareId,
            authority,
          });
        }
        if (typeof body.body !== 'string' || body.body.length === 0) {
          throw new InvalidCommentRequestError([
            { field: 'body', reason: 'is required when editing a post' },
          ]);
        }
        return service.editPost({
          installationId: context.installationId,
          workspaceId: context.workspaceId,
          postId: params.postId as string,
          shareId: context.shareId,
          authority,
          body: body.body,
        });
      },
    );
  }

  await registerAnonymous(
    '/api/v1/public/shares/:shareId',
    ShareParamsSchema,
    {
      query: ProtectedQueryBodySchema,
      thread: ProtectedThreadBodySchema,
      reply: ProtectedReplyBodySchema,
      threadMutation: ProtectedThreadMutationBodySchema,
      postMutation: ProtectedPostMutationBodySchema,
    },
    'protected',
  );
  await registerAnonymous(
    '/api/v1/public/links/:publicCode',
    PublicParamsSchema,
    {
      query: PublicQueryBodySchema,
      thread: PublicThreadBodySchema,
      reply: PublicReplyBodySchema,
      threadMutation: PublicThreadMutationBodySchema,
      postMutation: PublicPostMutationBodySchema,
    },
    'public',
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/comments',
    {
      schema: {
        operationId: 'listArtifactCommentsV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: ArtifactCommentsParamsSchema,
        querystring: CurrentRevisionQuerySchema,
        response: { 200: Type.Ref('CommentThreadPage'), ...errors },
      },
    },
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const query = request.query as {
        currentRevisionId?: string;
        cursor?: string;
        limit?: number;
      };
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: READ_REVISION_OPERATION,
      });
      const artifact = await dependencies.revisionRepository.findArtifact(params.artifactId);
      if (
        artifact === undefined ||
        artifact.installationId !== identity.installationId ||
        artifact.workspaceId !== params.workspaceId
      )
        throw new CommentNotFoundError();
      let currentRevisionId = artifact.latestRevision.revisionId;
      if (query.currentRevisionId !== undefined) {
        const requestedRevision = await dependencies.revisionRepository.findComparableRevision(
          query.currentRevisionId,
        );
        if (
          requestedRevision === undefined ||
          requestedRevision.installationId !== identity.installationId ||
          requestedRevision.workspaceId !== params.workspaceId ||
          requestedRevision.artifactId !== params.artifactId
        ) {
          throw new CommentNotFoundError();
        }
        currentRevisionId = query.currentRevisionId;
      }
      const items = await service.listArtifactThreads({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        artifactId: params.artifactId,
        currentRevisionId,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        authority: { kind: 'moderator', actorId: identity.actorId },
      });
      return commentPage(items);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/comments/threads',
    {
      schema: {
        operationId: 'createModeratorCommentThreadV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: ArtifactCommentsParamsSchema,
        body: Type.Object(
          {
            shareId: OpaqueShareIdSchema,
            anchor: CommentAnchorSchema,
            body: CommentBodySchema,
            displayName: Type.Optional(DisplayNameSchema),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Ref('CommentThread'), ...errors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const body = request.body as {
        shareId: string;
        anchor: CommentAnchor;
        body: string;
        displayName?: string;
      };
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: PUBLISH_OPERATION,
      });
      const share = await dependencies.shareRepository.findShare(body.shareId);
      if (
        share === undefined ||
        share.installationId !== identity.installationId ||
        share.workspaceId !== params.workspaceId ||
        share.artifactId !== params.artifactId
      ) {
        throw new CommentNotFoundError();
      }
      const result = await service.createThread({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        shareId: body.shareId,
        revisionId: body.anchor.revisionId,
        anchor: body.anchor,
        authority: {
          kind: 'moderator',
          actorId: identity.actorId,
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        },
        body: body.body,
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/comments/threads/:threadId/replies',
    {
      schema: {
        operationId: 'createModeratorCommentReplyV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: ArtifactThreadParamsSchema,
        body: Type.Object(
          { body: CommentBodySchema, displayName: Type.Optional(DisplayNameSchema) },
          { additionalProperties: false },
        ),
        response: { 201: Type.Ref('CommentPost'), ...errors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as {
        workspaceId: string;
        artifactId: string;
        threadId: string;
      };
      const body = request.body as { body: string; displayName?: string };
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: PUBLISH_OPERATION,
      });
      await ensureThreadArtifact(
        identity.installationId,
        params.workspaceId,
        params.artifactId,
        params.threadId,
      );
      const result = await service.createReply({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        authority: {
          kind: 'moderator',
          actorId: identity.actorId,
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        },
        body: body.body,
      });
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/comments/threads/:threadId',
    {
      schema: {
        operationId: 'moderateCommentThreadV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: ArtifactThreadParamsSchema,
        body: Type.Object(
          { status: Type.Union([Type.Literal('resolve'), Type.Literal('reopen')]) },
          { additionalProperties: false },
        ),
        response: { 200: Type.Ref('CommentThread'), ...errors },
      },
    },
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as {
        workspaceId: string;
        artifactId: string;
        threadId: string;
      };
      const body = request.body as { status: 'resolve' | 'reopen' };
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: PUBLISH_OPERATION,
      });
      await ensureThreadArtifact(
        identity.installationId,
        params.workspaceId,
        params.artifactId,
        params.threadId,
      );
      return service.resolveThread({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        reopen: body.status === 'reopen',
        authority: { kind: 'moderator', actorId: identity.actorId },
      });
    },
  );

  app.patch(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/comments/posts/:postId',
    {
      schema: {
        operationId: 'moderateCommentPostV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: ArtifactPostParamsSchema,
        body: ArtifactPostMutationBodySchema,
        response: { 200: Type.Ref('CommentPost'), ...errors },
      },
    },
    async (request) => {
      const params = request.params as { workspaceId: string; artifactId: string; postId: string };
      const body = request.body as Static<typeof ArtifactPostMutationBodySchema>;
      const identity = await authenticate(request, dependencies.authenticator);
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: PUBLISH_OPERATION,
      });
      await ensurePostArtifact(
        identity.installationId,
        params.workspaceId,
        params.artifactId,
        params.postId,
      );
      const authority = { kind: 'moderator' as const, actorId: identity.actorId };
      if ('action' in body) {
        if (body.action === 'delete') {
          return service.deletePost({
            installationId: identity.installationId,
            workspaceId: params.workspaceId,
            postId: params.postId,
            authority,
          });
        }
        return service.editPost({
          installationId: identity.installationId,
          workspaceId: params.workspaceId,
          postId: params.postId,
          authority,
          body: body.body,
        });
      }
      return service.moderatePost({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        postId: params.postId,
        actorId: identity.actorId,
        hidden: body.moderation === 'hide',
      });
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/comments/summaries',
    {
      schema: {
        operationId: 'summarizeCommentsV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: Type.Object(
          { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        body: SummaryBodySchema,
        response: {
          200: Type.Object({ items: Type.Array(Type.Ref('CommentSummary')) }),
          ...errors,
        },
      },
    },
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const body = request.body as { artifactIds: string[] };
      await dependencies.authorizer.authorize({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        action: READ_REVISION_OPERATION,
      });
      return commentPage({
        items: await service.summarizeArtifacts({
          installationId: identity.installationId,
          workspaceId: params.workspaceId,
          artifactIds: body.artifactIds,
        }),
        nextCursor: null,
      });
    },
  );

  app.patch(
    '/api/v1/workspaces/:workspaceId/shares/:shareId/comment-policy',
    {
      schema: {
        operationId: 'setShareCommentPolicyV1',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: WorkspaceShareParamsSchema,
        body: PolicyBodySchema,
        response: { 200: Type.Ref('ShareManagementSummary'), ...errors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; shareId: string };
      const body = request.body as { commentPolicy: CommentPolicy };
      return lifecycle.setCommentPolicy({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        shareId: params.shareId,
        commentPolicy: body.commentPolicy,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );
}
