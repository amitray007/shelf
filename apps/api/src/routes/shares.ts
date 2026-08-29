import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  FOLDER_LIMITS,
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  OpaqueShareIdSchema,
  PortableFolderPathSchema,
  type ProtectedSessionEstablishInput,
  PublicShareCodeSchema,
  type ShareCreateInput,
} from '@shelf/contracts';
import {
  createArtifactLifecycleService,
  createProtectedSessionEstablishmentService,
  createShareAccessService,
  createShareResolutionService,
  ShareNotFoundError,
} from '@shelf/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { contentDisposition, deliverContent } from '../content-delivery.js';
import { requestCancellationSignal } from '../request-cancellation.js';
import { createAuthenticatedShareLifecycle } from '../share-lifecycle.js';

const PUBLIC_API_PREFIX = '/api/v1/public/';
const AUTHORIZATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

const WorkspaceArtifactParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
  },
  { additionalProperties: false },
);
const WorkspaceParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const WorkspaceShareParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    shareId: OpaqueShareIdSchema,
  },
  { additionalProperties: false },
);
const ShareResolveQuerySchema = Type.Object(
  {
    shareId: Type.Optional(OpaqueShareIdSchema),
    publicCode: Type.Optional(PublicShareCodeSchema),
  },
  { additionalProperties: false },
);
const PublicShareParamsSchema = Type.Object(
  { shareId: OpaqueShareIdSchema },
  { additionalProperties: false },
);
const PublicLinkParamsSchema = Type.Object(
  { publicCode: PublicShareCodeSchema },
  { additionalProperties: false },
);
const IdempotencyHeadersSchema = Type.Object(
  {
    authorization: Type.Optional(Type.String()),
    'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: true },
);
// Keep one object schema here: Ajv removeAdditional mutates discriminated union branches before
// later branches can validate mode-specific expiry and session fields.
const HttpShareCreateBodySchema = Type.Unsafe<ShareCreateInput>({
  type: 'object',
  properties: {
    accessType: { type: 'string', enum: ['protected', 'public'] },
    target: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['latest', 'pinned'] },
        revisionId: { type: 'string', pattern: '^rev_[A-Za-z0-9_-]{22}$' },
      },
      required: ['mode'],
      additionalProperties: false,
      allOf: [
        {
          if: { properties: { mode: { const: 'pinned' } }, required: ['mode'] },
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditionals use then.
          then: { required: ['revisionId'] },
          else: { not: { required: ['revisionId'] } },
        },
      ],
    },
    expiresIn: {
      type: 'string',
      enum: ['never', '5m', '30m', '2hr', '6hr', '24hr', '3d', '7d', '15d', '30d'],
    },
    expiresAt: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
    },
    maxSessions: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    commentPolicy: { type: 'string', enum: ['off', 'private', 'shared'] },
    revisionAccess: { type: 'string', enum: ['target-only', 'shared-history'] },
  },
  required: ['accessType', 'target'],
  additionalProperties: false,
});
const SharePageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const ViewerTokenBodySchema = Type.Object(
  {
    token: Type.String({ minLength: 24, maxLength: 4096, pattern: '^[A-Za-z0-9._-]+$' }),
    revisionId: Type.Optional(OpaqueRevisionIdSchema),
  },
  { additionalProperties: false },
);
const RevisionSelectionQuerySchema = Type.Object(
  { revisionId: Type.Optional(OpaqueRevisionIdSchema) },
  { additionalProperties: false },
);
const PublicTreeQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FOLDER_LIMITS.treePageSize })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    revisionId: Type.Optional(OpaqueRevisionIdSchema),
  },
  { additionalProperties: false },
);
const PublicTreeFileQuerySchema = Type.Object(
  { path: PortableFolderPathSchema, revisionId: Type.Optional(OpaqueRevisionIdSchema) },
  { additionalProperties: false },
);
const ContentHeadersSchema = Type.Object(
  {
    range: Type.Optional(
      Type.String({
        maxLength: 256,
        description: 'One RFC 9110 bytes range. Multiple ranges are not supported.',
      }),
    ),
    'if-none-match': Type.Optional(
      Type.String({ maxLength: 1024, description: 'Conditional entity tag validator.' }),
    ),
  },
  { additionalProperties: true },
);

const managementErrors = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  409: Type.Ref('ErrorEnvelope'),
  499: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};
const anonymousResponseHeaders = {
  'Cache-Control': { type: 'string', description: 'Always no-store.' },
  'Referrer-Policy': { type: 'string', description: 'Always no-referrer.' },
  'X-Content-Type-Options': { type: 'string', description: 'Always nosniff.' },
  'X-Robots-Tag': { type: 'string', description: 'Always noindex, nofollow, noarchive.' },
};

function anonymousResponse<T extends object>(
  schema: T,
): T & { headers: typeof anonymousResponseHeaders } {
  return { ...schema, headers: anonymousResponseHeaders };
}

const publicErrors = {
  400: anonymousResponse(Type.Ref('ErrorEnvelope')),
  404: anonymousResponse(Type.Ref('ErrorEnvelope')),
  499: anonymousResponse(Type.Ref('ErrorEnvelope')),
  500: anonymousResponse(Type.Ref('ErrorEnvelope')),
  503: anonymousResponse(Type.Ref('ErrorEnvelope')),
};

const PublicContentResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Exact immutable file bytes, always delivered as an attachment.',
  }),
  headers: {
    ...anonymousResponseHeaders,
    'Content-Disposition': { type: 'string', description: 'Safe attachment file name.' },
    'Content-Length': { type: 'integer', description: 'Complete immutable byte count.' },
  },
};

const PublicPreviewResponseHeaders = {
  ...anonymousResponseHeaders,
  'Accept-Ranges': { type: 'string', description: 'Supported range unit; always bytes.' },
  'Content-Disposition': { type: 'string', description: 'Inline disposition with safe file name.' },
  'Content-Length': { type: 'integer', description: 'Selected byte count.' },
  ETag: { type: 'string', description: 'Strong SHA-256 entity tag for this file.' },
  'X-Content-Type-Options': { type: 'string', description: 'Always nosniff.' },
} as const;
const PublicPreviewPartialResponseHeaders = {
  ...PublicPreviewResponseHeaders,
  'Content-Range': { type: 'string', description: 'Inclusive byte range and full size.' },
} as const;
const PublicPreviewResponseSchema = {
  ...Type.String({ format: 'binary', description: 'Immutable media bytes delivered inline.' }),
  headers: PublicPreviewResponseHeaders,
};
const PublicPreviewPartialResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Selected immutable media bytes delivered inline.',
  }),
  headers: PublicPreviewPartialResponseHeaders,
};
const PublicPreviewNotModifiedResponseSchema = {
  ...Type.Null({ description: 'The entity tag matched; no bytes are returned.' }),
  headers: {
    ...anonymousResponseHeaders,
    'Accept-Ranges': { type: 'string' },
    ETag: { type: 'string' },
  },
};
const PublicPreviewRangeErrorResponseSchema = {
  ...Type.Ref('ErrorEnvelope'),
  headers: { ...anonymousResponseHeaders, 'Content-Range': { type: 'string' } },
};

function encodedFileName(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function attachmentDisposition(originalFileName: string, revisionId: string): string {
  const leaf = originalFileName.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  let unicodeName = Array.from(leaf)
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point > 31 && point !== 127;
    })
    .join('')
    .trim()
    .toWellFormed();
  if (unicodeName === '' || unicodeName === '.' || unicodeName === '..') {
    unicodeName = `share-${revisionId}.bin`;
  }
  let asciiName = unicodeName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\;]/gu, '_');
  if (asciiName === '' || asciiName === '.' || asciiName === '..') {
    asciiName = `share-${revisionId}.bin`;
  }
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedFileName(unicodeName)}`;
}

const VIEWER_SESSION_COOKIE_PREFIX = 'shelf_viewer_session_';
const VIEWER_SESSION_COOKIE_SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const VIEWER_SESSION_COOKIE_TOKEN_PATTERN = /^[A-Za-z0-9._-]{100,3072}$/u;

function viewerSessionCookieName(shareId: string): string {
  return `${VIEWER_SESSION_COOKIE_PREFIX}${shareId}`;
}

function viewerSessionCookie(
  request: { protocol: string },
  shareId: string,
  token: string,
  issuedAt: string,
  expiresAt: string,
  now: Date,
): string {
  if (
    !VIEWER_SESSION_COOKIE_SHARE_ID_PATTERN.test(shareId) ||
    !VIEWER_SESSION_COOKIE_TOKEN_PATTERN.test(token)
  ) {
    throw new Error('Cannot issue an invalid viewer-session cookie.');
  }
  const nowTimestamp = now.getTime();
  const issuedTimestamp = Date.parse(issuedAt);
  const expiryTimestamp = Date.parse(expiresAt);
  const referenceTimestamp =
    Number.isFinite(nowTimestamp) && Number.isFinite(issuedTimestamp)
      ? Math.max(nowTimestamp, issuedTimestamp)
      : nowTimestamp;
  const lifetimeSeconds =
    Number.isFinite(referenceTimestamp) && Number.isFinite(expiryTimestamp)
      ? Math.max(0, Math.floor((expiryTimestamp - referenceTimestamp) / 1_000))
      : 0;
  const secure = request.protocol === 'https' || process.env.NODE_ENV === 'production';
  return [
    `${viewerSessionCookieName(shareId)}=${token}`,
    `Path=/api/v1/public/shares/${shareId}`,
    `Max-Age=${lifetimeSeconds}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function readViewerSessionCookie(
  request: { headers: { cookie?: string | undefined } },
  shareId: string,
): string | undefined {
  if (!VIEWER_SESSION_COOKIE_SHARE_ID_PATTERN.test(shareId)) return undefined;
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  const name = `${viewerSessionCookieName(shareId)}=`;
  for (const item of header.split(';')) {
    const trimmed = item.trimStart();
    if (trimmed.startsWith(name)) {
      const value = trimmed.slice(name.length).trim();
      return value !== '' && VIEWER_SESSION_COOKIE_TOKEN_PATTERN.test(value) ? value : undefined;
    }
  }
  return undefined;
}

export async function registerShareRoutes(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4_096 },
    (_request, body, done) => {
      const parameters = new URLSearchParams(String(body));
      const keys = [...parameters.keys()];
      const token = parameters.getAll('token');
      const revisionId = parameters.getAll('revisionId');
      done(
        null,
        keys.every((key) => key === 'token' || key === 'revisionId') &&
          token.length === 1 &&
          revisionId.length <= 1
          ? {
              token: token[0],
              ...(revisionId[0] === undefined ? {} : { revisionId: revisionId[0] }),
            }
          : {},
      );
    },
  );
  const lifecycle = createAuthenticatedShareLifecycle(dependencies);
  const artifacts = createArtifactLifecycleService({
    authorizer: dependencies.authorizer,
    artifacts: dependencies.revisionRepository,
    deletions: dependencies.artifactDeletionRepository,
    ...(dependencies.artifactClock === undefined ? {} : { clock: dependencies.artifactClock }),
  });
  const resolution = createShareResolutionService({
    shares: dependencies.shareRepository,
    revisions: dependencies.revisionRepository,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });
  const establish = createProtectedSessionEstablishmentService({
    shares: dependencies.shareRepository,
    capabilityCodec: dependencies.shareCapabilityCodec,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });
  const access = createShareAccessService({
    shares: dependencies.shareRepository,
    revisions: dependencies.revisionRepository,
    folders: dependencies.revisionRepository,
    contentReader: dependencies.contentReader,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });
  const clock = dependencies.shareClock ?? (() => new Date());

  function protectedAuthority(shareId: string, token: string) {
    const claims = dependencies.viewerSessionTokenCodec.verify(token, {
      now: clock(),
      shareId,
    });
    if (claims === undefined) throw new ShareNotFoundError();
    return { type: 'protected-session' as const, shareId, sessionId: claims.sessionId };
  }

  function protectedCookieAuthority(
    request: { headers: { cookie?: string | undefined } },
    shareId: string,
  ) {
    const token = readViewerSessionCookie(request, shareId);
    if (token === undefined) throw new ShareNotFoundError();
    return protectedAuthority(shareId, token);
  }

  function issueAuthority(authorization: {
    shareId: string;
    sessionId: string;
    issuedAt: string;
    expiresAt: string;
  }) {
    const token = dependencies.viewerSessionTokenCodec.issue({
      shareId: authorization.shareId,
      sessionId: authorization.sessionId,
      issuedAt: authorization.issuedAt,
      accessExpiresAt: authorization.expiresAt,
    });
    return {
      apiVersion: 'v1' as const,
      shareId: authorization.shareId,
      sessionId: authorization.sessionId,
      token,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
    };
  }

  function sendAuthority(
    request: { protocol: string },
    reply: FastifyReply,
    authorization: {
      shareId: string;
      sessionId: string;
      issuedAt: string;
      expiresAt: string;
    },
  ) {
    const result = issueAuthority(authorization);
    void reply.header(
      'set-cookie',
      viewerSessionCookie(
        request,
        authorization.shareId,
        result.token,
        authorization.issuedAt,
        authorization.expiresAt,
        clock(),
      ),
    );
    return result;
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(PUBLIC_API_PREFIX)) return;
    void reply.header('Cache-Control', 'no-store');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  });

  app.post(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/shares',
    {
      schema: {
        operationId: 'createShareV1',
        summary: 'Create an unlisted latest or pinned share',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['shares'],
        params: WorkspaceArtifactParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: HttpShareCreateBodySchema,
        response: { 201: Type.Ref('ShareCreateResult'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const headers = request.headers as { 'idempotency-key': string };
      const body = request.body as ShareCreateInput;
      const deletion = await dependencies.artifactDeletionRepository.findArtifactForDeletion(
        params.artifactId,
      );
      if (
        deletion?.deletedAt !== null &&
        deletion?.artifact.installationId === identity.installationId &&
        deletion.artifact.workspaceId === params.workspaceId
      ) {
        await artifacts.recoverArtifact({
          installationId: identity.installationId,
          actorId: identity.actorId,
          artifactId: params.artifactId,
          idempotencyKey: `share-recovery-${createHash('sha256')
            .update(headers['idempotency-key'])
            .digest('hex')}`,
          signal: requestCancellationSignal(request, reply),
        });
      }
      const result = await lifecycle.createShare({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        target: body.target,
        accessType: body.accessType,
        ...('expiresIn' in body ? { expiresIn: body.expiresIn } : {}),
        ...('expiresAt' in body ? { expiresAt: body.expiresAt } : {}),
        ...('maxSessions' in body && body.maxSessions !== undefined
          ? { maxSessions: body.maxSessions }
          : {}),
        ...('commentPolicy' in body && body.commentPolicy !== undefined
          ? { commentPolicy: body.commentPolicy }
          : {}),
        ...('revisionAccess' in body && body.revisionAccess !== undefined
          ? { revisionAccess: body.revisionAccess }
          : {}),
        idempotencyKey: headers['idempotency-key'],
        requestId: request.id,
        signal: requestCancellationSignal(request, reply),
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/shares/defaults',
    {
      schema: {
        operationId: 'ensureArtifactDefaultSharesV1',
        summary: 'Return or provision the permanent Latest Protected and Public links',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['shares'],
        params: WorkspaceArtifactParamsSchema,
        response: { 200: Type.Ref('ArtifactDefaultShares'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const result = await lifecycle.ensureDefaultShares({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        requestId: request.id,
        signal: requestCancellationSignal(request, reply),
      });
      return reply.status(200).send(result);
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/shares',
    {
      schema: {
        operationId: 'listSharesV1',
        summary: 'List reusable share links for authorized workspace management',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['shares'],
        params: WorkspaceParamsSchema,
        querystring: SharePageQuerySchema,
        response: { 200: Type.Ref('SharePage'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const query = request.query as { limit?: number; cursor?: string };
      return lifecycle.listShares({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        limit: query.limit ?? 20,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/shares/resolve',
    {
      schema: {
        operationId: 'resolveManagedShareV1',
        summary: 'Resolve a share ID or Public selector to its artifact',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['shares'],
        params: WorkspaceParamsSchema,
        querystring: ShareResolveQuerySchema,
        response: { 200: Type.Ref('ShareManagementSummary'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const query = request.query as { shareId?: string; publicCode?: string };
      return lifecycle.resolveManagedShare({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        ...(query.shareId === undefined ? {} : { shareId: query.shareId }),
        ...(query.publicCode === undefined ? {} : { publicCode: query.publicCode }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.delete(
    '/api/v1/workspaces/:workspaceId/shares/:shareId',
    {
      schema: {
        operationId: 'revokeShareV1',
        summary: 'Idempotently revoke one share',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['shares'],
        params: WorkspaceShareParamsSchema,
        response: { 200: Type.Ref('ShareManagementSummary'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; shareId: string };
      return lifecycle.revokeShare({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        shareId: params.shareId,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/sessions',
    {
      schema: {
        operationId: 'establishProtectedShareSessionV1',
        summary: 'Establish or renew one bounded Protected viewer session',
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        body: Type.Ref('ProtectedSessionEstablishInput'),
        response: {
          200: anonymousResponse(Type.Ref('ProtectedSessionAuthority')),
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as ProtectedSessionEstablishInput;
      if ('secret' in body) {
        return sendAuthority(
          request,
          reply,
          await establish({
            shareId: params.shareId,
            sessionId: body.sessionId,
            secret: body.secret,
            signal: requestCancellationSignal(request, reply),
          }),
        );
      }
      const now = clock();
      const claims = dependencies.viewerSessionTokenCodec.verify(body.token, {
        now,
        shareId: params.shareId,
        sessionId: body.sessionId,
        allowExpired: true,
      });
      if (claims === undefined) throw new ShareNotFoundError();
      const resolved = await resolution({
        authority: {
          type: 'protected-session',
          shareId: claims.shareId,
          sessionId: claims.sessionId,
        },
        signal: requestCancellationSignal(request, reply),
      });
      const policyExpiry =
        resolved.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(resolved.expiresAt);
      const expiresAt = new Date(
        Math.min(now.getTime() + AUTHORIZATION_LIFETIME_MS, policyExpiry),
      ).toISOString();
      return sendAuthority(request, reply, {
        shareId: claims.shareId,
        sessionId: claims.sessionId,
        issuedAt: now.toISOString(),
        expiresAt,
      });
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/resolve',
    {
      schema: {
        operationId: 'resolveProtectedShareV1',
        summary: 'Resolve a Protected share with established viewer authority',
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        body: ViewerTokenBodySchema,
        response: {
          200: anonymousResponse(Type.Ref('PublicShareResolution')),
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { token: string; revisionId?: string };
      return resolution({
        authority: protectedAuthority(params.shareId, body.token),
        ...(body.revisionId === undefined ? {} : { revisionId: body.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/content',
    {
      schema: {
        operationId: 'downloadProtectedShareContentV1',
        summary: 'Download Protected shared file bytes with established viewer authority',
        produces: ['application/octet-stream'],
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        body: ViewerTokenBodySchema,
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { token: string; revisionId?: string };
      const file = await access.readFile({
        authority: protectedAuthority(params.shareId, body.token),
        ...(body.revisionId === undefined ? {} : { revisionId: body.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type('application/octet-stream')
        .header(
          'Content-Disposition',
          attachmentDisposition(file.originalFileName, file.revisionId),
        )
        .header('Content-Length', file.byteCount)
        .send(Readable.from(await file.read()));
    },
  );

  app.get(
    '/api/v1/public/shares/:shareId/content/preview',
    {
      schema: {
        operationId: 'previewProtectedShareContentV1',
        summary: 'Preview Protected shared file bytes with a viewer-session cookie',
        description:
          'Returns the stored media type inline and supports validators and one bytes range. The viewer session is read only from a narrow cookie set by session establishment.',
        produces: ['application/octet-stream'],
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        headers: ContentHeadersSchema,
        querystring: RevisionSelectionQuerySchema,
        response: {
          200: PublicPreviewResponseSchema,
          206: PublicPreviewPartialResponseSchema,
          304: PublicPreviewNotModifiedResponseSchema,
          416: PublicPreviewRangeErrorResponseSchema,
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const query = request.query as { revisionId?: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const file = await access.readFile({
        authority: protectedCookieAuthority(request, params.shareId),
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return deliverContent(
        reply,
        { range: headers.range, ifNoneMatch: headers['if-none-match'] },
        {
          mediaType: file.mediaType,
          byteCount: file.byteCount,
          contentHash: file.contentHash,
          originalFileName: file.originalFileName,
          read: file.read,
        },
        { disposition: 'inline', fallbackFileName: `share-${file.revisionId}.bin` },
      );
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/tree',
    {
      schema: {
        operationId: 'getProtectedShareTreeV1',
        summary: 'Page a Protected shared folder tree with established viewer authority',
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        querystring: PublicTreeQuerySchema,
        body: ViewerTokenBodySchema,
        response: { 200: anonymousResponse(Type.Ref('FolderTreePage')), ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { token: string; revisionId?: string };
      const query = request.query as { limit?: number; cursor?: string; revisionId?: string };
      return access.readTree({
        authority: protectedAuthority(params.shareId, body.token),
        ...(body.revisionId === undefined ? {} : { revisionId: body.revisionId }),
        limit: query.limit ?? FOLDER_LIMITS.treePageSize,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/tree/content',
    {
      schema: {
        operationId: 'downloadProtectedShareFolderEntryV1',
        summary: 'Read one file from a Protected shared folder',
        produces: ['application/octet-stream'],
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        querystring: PublicTreeFileQuerySchema,
        body: ViewerTokenBodySchema,
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const query = request.query as { path: string; revisionId?: string };
      const body = request.body as { token: string; revisionId?: string };
      const file = await access.readTreeFile({
        authority: protectedAuthority(params.shareId, body.token),
        path: query.path,
        ...(body.revisionId === undefined ? {} : { revisionId: body.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type(file.mediaType)
        .header('Content-Disposition', contentDisposition(file.path, 'file', 'attachment'))
        .header('Content-Length', file.byteCount)
        .header('ETag', `"${file.contentHash}"`)
        .send(Readable.from(await file.read()));
    },
  );

  app.get(
    '/api/v1/public/shares/:shareId/tree/content/preview',
    {
      schema: {
        operationId: 'previewProtectedShareFolderEntryV1',
        summary: 'Preview one Protected shared folder file with a viewer-session cookie',
        description:
          'Returns the stored media type inline and supports validators and one bytes range.',
        produces: ['application/octet-stream'],
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        headers: ContentHeadersSchema,
        querystring: PublicTreeFileQuerySchema,
        response: {
          200: PublicPreviewResponseSchema,
          206: PublicPreviewPartialResponseSchema,
          304: PublicPreviewNotModifiedResponseSchema,
          416: PublicPreviewRangeErrorResponseSchema,
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const query = request.query as { path: string; revisionId?: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const file = await access.readTreeFile({
        authority: protectedCookieAuthority(request, params.shareId),
        path: query.path,
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return deliverContent(
        reply,
        { range: headers.range, ifNoneMatch: headers['if-none-match'] },
        {
          mediaType: file.mediaType,
          byteCount: file.byteCount,
          contentHash: file.contentHash,
          originalFileName: file.path,
          read: file.read,
        },
        { disposition: 'inline', fallbackFileName: 'file' },
      );
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/resolve',
    {
      schema: {
        operationId: 'resolvePublicLinkV1',
        summary: 'Resolve a secret-free Public share link',
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        querystring: RevisionSelectionQuerySchema,
        response: {
          200: anonymousResponse(Type.Ref('PublicShareResolution')),
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { revisionId?: string };
      return resolution({
        authority: { type: 'public', publicCode: params.publicCode },
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/content',
    {
      schema: {
        operationId: 'downloadPublicLinkContentV1',
        summary: 'Download secret-free Public shared file bytes',
        produces: ['application/octet-stream'],
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        querystring: RevisionSelectionQuerySchema,
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { revisionId?: string };
      const file = await access.readFile({
        authority: { type: 'public', publicCode: params.publicCode },
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type('application/octet-stream')
        .header(
          'Content-Disposition',
          attachmentDisposition(file.originalFileName, file.revisionId),
        )
        .header('Content-Length', file.byteCount)
        .send(Readable.from(await file.read()));
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/content/preview',
    {
      schema: {
        operationId: 'previewPublicLinkContentV1',
        summary: 'Preview secret-free Public shared file bytes inline',
        description:
          'Returns the stored media type inline and supports validators and one bytes range.',
        produces: ['application/octet-stream'],
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        headers: ContentHeadersSchema,
        querystring: RevisionSelectionQuerySchema,
        response: {
          200: PublicPreviewResponseSchema,
          206: PublicPreviewPartialResponseSchema,
          304: PublicPreviewNotModifiedResponseSchema,
          416: PublicPreviewRangeErrorResponseSchema,
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { revisionId?: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const file = await access.readFile({
        authority: { type: 'public', publicCode: params.publicCode },
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return deliverContent(
        reply,
        { range: headers.range, ifNoneMatch: headers['if-none-match'] },
        {
          mediaType: file.mediaType,
          byteCount: file.byteCount,
          contentHash: file.contentHash,
          originalFileName: file.originalFileName,
          read: file.read,
        },
        { disposition: 'inline', fallbackFileName: `share-${file.revisionId}.bin` },
      );
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/tree',
    {
      schema: {
        operationId: 'getPublicLinkTreeV1',
        summary: 'Page a secret-free Public shared folder tree',
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        querystring: PublicTreeQuerySchema,
        response: { 200: anonymousResponse(Type.Ref('FolderTreePage')), ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { limit?: number; cursor?: string; revisionId?: string };
      return access.readTree({
        authority: { type: 'public', publicCode: params.publicCode },
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        limit: query.limit ?? FOLDER_LIMITS.treePageSize,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/tree/content',
    {
      schema: {
        operationId: 'downloadPublicLinkFolderEntryV1',
        summary: 'Read one file from a secret-free Public shared folder',
        produces: ['application/octet-stream'],
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        querystring: PublicTreeFileQuerySchema,
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { path: string; revisionId?: string };
      const file = await access.readTreeFile({
        authority: { type: 'public', publicCode: params.publicCode },
        path: query.path,
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type(file.mediaType)
        .header('Content-Disposition', contentDisposition(file.path, 'file', 'attachment'))
        .header('Content-Length', file.byteCount)
        .header('ETag', `"${file.contentHash}"`)
        .send(Readable.from(await file.read()));
    },
  );

  app.get(
    '/api/v1/public/links/:publicCode/tree/content/preview',
    {
      schema: {
        operationId: 'previewPublicLinkFolderEntryV1',
        summary: 'Preview one secret-free Public shared folder file inline',
        description:
          'Returns the stored media type inline and supports validators and one bytes range.',
        produces: ['application/octet-stream'],
        tags: ['public links'],
        params: PublicLinkParamsSchema,
        headers: ContentHeadersSchema,
        querystring: PublicTreeFileQuerySchema,
        response: {
          200: PublicPreviewResponseSchema,
          206: PublicPreviewPartialResponseSchema,
          304: PublicPreviewNotModifiedResponseSchema,
          416: PublicPreviewRangeErrorResponseSchema,
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const query = request.query as { path: string; revisionId?: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const file = await access.readTreeFile({
        authority: { type: 'public', publicCode: params.publicCode },
        path: query.path,
        ...(query.revisionId === undefined ? {} : { revisionId: query.revisionId }),
        signal: requestCancellationSignal(request, reply),
      });
      return deliverContent(
        reply,
        { range: headers.range, ifNoneMatch: headers['if-none-match'] },
        {
          mediaType: file.mediaType,
          byteCount: file.byteCount,
          contentHash: file.contentHash,
          originalFileName: file.path,
          read: file.read,
        },
        { disposition: 'inline', fallbackFileName: 'file' },
      );
    },
  );
}
