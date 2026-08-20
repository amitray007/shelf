import { Readable } from 'node:stream';

import {
  FOLDER_LIMITS,
  OpaqueArtifactIdSchema,
  OpaqueShareIdSchema,
  PortableFolderPathSchema,
  type ProtectedSessionEstablishInput,
  PublicShareCodeSchema,
  type ShareCreateInput,
} from '@shelf/contracts';
import {
  createProtectedSessionEstablishmentService,
  createShareAccessService,
  createShareResolutionService,
  ShareNotFoundError,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
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
  },
  { additionalProperties: false },
);
const PublicTreeQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FOLDER_LIMITS.treePageSize })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const PublicTreeFileQuerySchema = Type.Object(
  { path: PortableFolderPathSchema },
  { additionalProperties: false },
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
      done(
        null,
        keys.length === 1 && keys[0] === 'token' && parameters.getAll('token').length === 1
          ? { token: parameters.get('token') }
          : {},
      );
    },
  );
  const lifecycle = createAuthenticatedShareLifecycle(dependencies);
  const resolution = createShareResolutionService({
    shares: dependencies.shareRepository,
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
        return issueAuthority(
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
      return issueAuthority({
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
      const body = request.body as { token: string };
      return resolution({
        authority: protectedAuthority(params.shareId, body.token),
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
      const body = request.body as { token: string };
      const file = await access.readFile({
        authority: protectedAuthority(params.shareId, body.token),
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
      const body = request.body as { token: string };
      const query = request.query as { limit?: number; cursor?: string };
      return access.readTree({
        authority: protectedAuthority(params.shareId, body.token),
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
      const query = request.query as { path: string };
      const body = request.body as { token: string };
      const file = await access.readTreeFile({
        authority: protectedAuthority(params.shareId, body.token),
        path: query.path,
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type(file.mediaType)
        .header('Content-Length', file.byteCount)
        .header('ETag', `"${file.contentHash}"`)
        .send(Readable.from(await file.read()));
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
        response: {
          200: anonymousResponse(Type.Ref('PublicShareResolution')),
          ...publicErrors,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      return resolution({
        authority: { type: 'public', publicCode: params.publicCode },
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
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { publicCode: string };
      const file = await access.readFile({
        authority: { type: 'public', publicCode: params.publicCode },
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
      const query = request.query as { limit?: number; cursor?: string };
      return access.readTree({
        authority: { type: 'public', publicCode: params.publicCode },
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
      const query = request.query as { path: string };
      const file = await access.readTreeFile({
        authority: { type: 'public', publicCode: params.publicCode },
        path: query.path,
        signal: requestCancellationSignal(request, reply),
      });
      return reply
        .type(file.mediaType)
        .header('Content-Length', file.byteCount)
        .header('ETag', `"${file.contentHash}"`)
        .send(Readable.from(await file.read()));
    },
  );
}
