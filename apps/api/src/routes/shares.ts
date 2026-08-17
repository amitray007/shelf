import { Readable } from 'node:stream';

import {
  FOLDER_LIMITS,
  OpaqueArtifactIdSchema,
  OpaqueShareIdSchema,
  type ShareTarget,
} from '@shelf/contracts';
import {
  createShareAccessService,
  createShareLifecycleService,
  createShareResolutionService,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';

const PUBLIC_SHARE_PREFIX = '/api/v1/public/shares/';
const FORM_CAPABILITY_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const MAX_FORM_CAPABILITY_BYTES = 1_024;

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
  { shareId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const IdempotencyHeadersSchema = Type.Object(
  {
    authorization: Type.Optional(Type.String()),
    'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: true },
);
// A conditional object avoids Ajv's removeAdditional mutation across union branches.
const HttpShareTargetSchema = Type.Unsafe<ShareTarget>({
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
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditionals use the standard then keyword.
      then: { required: ['revisionId'] },
      else: { not: { required: ['revisionId'] } },
    },
  ],
});
const ShareCreateBodySchema = Type.Object(
  {
    target: HttpShareTargetSchema,
    expiresAt: Type.Optional(
      Type.Union([
        Type.String({
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
        }),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: false },
);
const SharePageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const CapabilityBodySchema = Type.Object(
  {
    secret: Type.String({ maxLength: 512 }),
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
const publicErrors = {
  400: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  499: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};

const PublicContentResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Exact immutable file bytes, always delivered as an attachment.',
  }),
  headers: {
    'Cache-Control': { type: 'string', description: 'Always no-store.' },
    'Content-Disposition': { type: 'string', description: 'Safe attachment file name.' },
    'Content-Length': { type: 'integer', description: 'Complete immutable byte count.' },
    'Referrer-Policy': { type: 'string', description: 'Always no-referrer.' },
    'X-Content-Type-Options': { type: 'string', description: 'Always nosniff.' },
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
    FORM_CAPABILITY_CONTENT_TYPE,
    { parseAs: 'string', bodyLimit: MAX_FORM_CAPABILITY_BYTES },
    (_request, body, done) => {
      const parameters = new URLSearchParams(
        typeof body === 'string' ? body : body.toString('utf8'),
      );
      const secrets = parameters.getAll('secret');
      if (secrets.length !== 1 || Array.from(parameters.keys()).some((key) => key !== 'secret')) {
        done(null, {});
        return;
      }
      done(null, { secret: secrets[0] });
    },
  );
  const lifecycle = createShareLifecycleService({
    authorizer: dependencies.authorizer,
    shares: dependencies.shareRepository,
    capabilityCodec: dependencies.shareCapabilityCodec,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
    ...(dependencies.generateShareId === undefined
      ? {}
      : { generateShareId: dependencies.generateShareId }),
  });
  const resolution = createShareResolutionService({
    shares: dependencies.shareRepository,
    capabilityCodec: dependencies.shareCapabilityCodec,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });
  const access = createShareAccessService({
    shares: dependencies.shareRepository,
    capabilityCodec: dependencies.shareCapabilityCodec,
    revisions: dependencies.revisionRepository,
    folders: dependencies.revisionRepository,
    contentReader: dependencies.contentReader,
    ...(dependencies.shareClock === undefined ? {} : { clock: dependencies.shareClock }),
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(PUBLIC_SHARE_PREFIX)) return;
    void reply.header('Cache-Control', 'no-store');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header('X-Content-Type-Options', 'nosniff');
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
        body: ShareCreateBodySchema,
        response: { 201: Type.Ref('ShareCreateResult'), ...managementErrors },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const headers = request.headers as { 'idempotency-key': string };
      const body = request.body as { target: ShareTarget; expiresAt?: string | null };
      const result = await lifecycle.createShare({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        target: body.target,
        ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        idempotencyKey: headers['idempotency-key'],
        requestId: request.id,
        signal: requestCancellationSignal(request, reply),
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/shares',
    {
      schema: {
        operationId: 'listSharesV1',
        summary: 'List share management records without capability material',
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
    '/api/v1/public/shares/:shareId/resolve',
    {
      schema: {
        operationId: 'resolvePublicShareV1',
        summary: 'Resolve an unlisted share capability',
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        body: CapabilityBodySchema,
        response: { 200: Type.Ref('PublicShareResolution'), ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { secret: string };
      return resolution({
        shareId: params.shareId,
        secret: body.secret,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/public/shares/:shareId/content',
    {
      schema: {
        operationId: 'downloadPublicShareContentV1',
        summary: 'Download exact shared file bytes as an attachment',
        consumes: ['application/json', FORM_CAPABILITY_CONTENT_TYPE],
        produces: ['application/octet-stream'],
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        body: CapabilityBodySchema,
        response: { 200: PublicContentResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { secret: string };
      const file = await access.readFile({
        shareId: params.shareId,
        secret: body.secret,
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
        operationId: 'getPublicShareTreeV1',
        summary: 'Page the exact shared folder tree',
        tags: ['public shares'],
        params: PublicShareParamsSchema,
        querystring: PublicTreeQuerySchema,
        body: CapabilityBodySchema,
        response: { 200: Type.Ref('FolderTreePage'), ...publicErrors },
      },
    },
    async (request, reply) => {
      const params = request.params as { shareId: string };
      const body = request.body as { secret: string };
      const query = request.query as { limit?: number; cursor?: string };
      return access.readTree({
        shareId: params.shareId,
        secret: body.secret,
        limit: query.limit ?? FOLDER_LIMITS.treePageSize,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );
}
