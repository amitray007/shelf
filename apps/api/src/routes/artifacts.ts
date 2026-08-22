import { createHash } from 'node:crypto';

import {
  ArtifactDeletionResultSchema,
  ArtifactNameSchema,
  ArtifactPageSchema,
  ArtifactRetentionModeSchema,
  ArtifactRevisionPageSchema,
  ArtifactSchema,
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  RestoreResultSchema,
  TrashedArtifactSchema,
  TrashPageSchema,
} from '@shelf/contracts';
import {
  createArtifactCatalogService,
  createArtifactLifecycleService,
  createArtifactRetentionService,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';
import { createAuthenticatedShareLifecycle } from '../share-lifecycle.js';

const ArtifactParamsSchema = Type.Object(
  { artifactId: OpaqueArtifactIdSchema },
  { additionalProperties: false },
);

const WorkspaceParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);

const WorkspaceArtifactParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
  },
  { additionalProperties: false },
);

const RenameArtifactBodySchema = Type.Object(
  { name: ArtifactNameSchema },
  { additionalProperties: false },
);

const RestoreArtifactBodySchema = Type.Object(
  { sourceRevisionId: OpaqueRevisionIdSchema },
  { additionalProperties: false },
);

const ArtifactRetentionBodySchema = Type.Object(
  { mode: ArtifactRetentionModeSchema },
  { additionalProperties: false },
);

const TrashPageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const IdempotencyHeadersSchema = Type.Object(
  {
    authorization: Type.Optional(Type.String()),
    'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: true },
);

const PageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    sort: Type.Optional(Type.Union([Type.Literal('created'), Type.Literal('updated')])),
    order: Type.Optional(Type.Union([Type.Literal('asc'), Type.Literal('desc')])),
    search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

const ArtifactHistoryQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    order: Type.Optional(Type.Union([Type.Literal('newest'), Type.Literal('oldest')])),
  },
  { additionalProperties: false },
);

const errorResponses = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  409: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};

export async function registerArtifactRoutes(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
): Promise<void> {
  const catalog = createArtifactCatalogService({
    authorizer: dependencies.authorizer,
    artifacts: dependencies.revisionRepository,
  });
  const lifecycle = createArtifactLifecycleService({
    authorizer: dependencies.authorizer,
    artifacts: dependencies.revisionRepository,
    deletions: dependencies.artifactDeletionRepository,
    ...(dependencies.artifactClock === undefined ? {} : { clock: dependencies.artifactClock }),
  });
  const retention = createArtifactRetentionService({
    authorizer: dependencies.authorizer,
    artifacts: dependencies.revisionRepository,
    ...(dependencies.artifactClock === undefined ? {} : { clock: dependencies.artifactClock }),
  });
  const shares = createAuthenticatedShareLifecycle(dependencies);

  app.patch(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/retention',
    {
      schema: {
        operationId: 'setArtifactRetentionV1',
        summary: 'Keep an artifact or return it to automatic Trash retention',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: WorkspaceArtifactParamsSchema,
        body: ArtifactRetentionBodySchema,
        response: { 200: ArtifactSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const body = request.body as { mode: 'automatic' | 'keep' };
      return retention.setRetention({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        mode: body.mode,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/trash',
    {
      schema: {
        operationId: 'listTrashV1',
        summary: 'List recoverable artifacts in Trash',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: WorkspaceParamsSchema,
        querystring: TrashPageQuerySchema,
        response: { 200: TrashPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const query = request.query as { limit?: number; cursor?: string; search?: string };
      return retention.listTrash({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        limit: query.limit ?? 20,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.search === undefined ? {} : { search: query.search }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/trash/:artifactId',
    {
      schema: {
        operationId: 'getTrashedArtifactV1',
        summary: 'Get one recoverable artifact from Trash by artifact ID',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        response: { 200: TrashedArtifactSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      return retention.getTrash({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.delete(
    '/api/v1/artifacts/:artifactId',
    {
      schema: {
        operationId: 'deleteArtifactV1',
        summary: 'Soft-delete an artifact for 30-day recovery and revoke its active shares',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        response: { 200: ArtifactDeletionResultSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      return lifecycle.deleteArtifact({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/artifacts/:artifactId/recovery',
    {
      schema: {
        operationId: 'recoverArtifactV1',
        summary: 'Recover a soft-deleted artifact during its 30-day recovery window',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        headers: IdempotencyHeadersSchema,
        response: {
          200: Type.Ref('ArtifactRecoveryResult'),
          410: Type.Ref('ErrorEnvelope'),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      const headers = request.headers as { 'idempotency-key': string };
      const signal = requestCancellationSignal(request, reply);
      const artifact = await lifecycle.recoverArtifact({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        idempotencyKey: headers['idempotency-key'],
        signal,
      });
      const recoveryShare = await shares.createShare({
        installationId: identity.installationId,
        workspaceId: artifact.workspaceId,
        actorId: identity.actorId,
        artifactId: artifact.artifactId,
        accessType: 'protected',
        target: { mode: 'latest' },
        expiresIn: '7d',
        purpose: 'artifact-recovery',
        idempotencyKey: `recovery-lease-${createHash('sha256')
          .update(headers['idempotency-key'])
          .digest('hex')}`,
        requestId: request.id,
        signal,
      });
      return { apiVersion: 'v1', artifact, recoveryShare };
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/artifacts',
    {
      schema: {
        operationId: 'listArtifactsV1',
        summary: 'List artifacts in one workspace',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: WorkspaceParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: ArtifactPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const query = request.query as {
        limit?: number;
        cursor?: string;
        sort?: 'created' | 'updated';
        order?: 'asc' | 'desc';
        search?: string;
      };
      return catalog.listArtifacts({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        limit: query.limit ?? 20,
        sort: query.sort ?? 'updated',
        order: query.order ?? 'desc',
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/artifacts/:artifactId',
    {
      schema: {
        operationId: 'getArtifactV1',
        summary: 'Get one artifact and its latest revision',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        response: { 200: ArtifactSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      return catalog.getArtifact({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    '/api/v1/artifacts/:artifactId/revisions',
    {
      schema: {
        operationId: 'listArtifactRevisionsV1',
        summary: 'List one artifact revision history',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        querystring: ArtifactHistoryQuerySchema,
        response: { 200: ArtifactRevisionPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      const query = request.query as {
        limit?: number;
        cursor?: string;
        order?: 'newest' | 'oldest';
      };
      return catalog.listArtifactRevisions({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        limit: query.limit ?? 20,
        order: query.order ?? 'newest',
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.patch(
    '/api/v1/artifacts/:artifactId',
    {
      schema: {
        operationId: 'renameArtifactV1',
        summary: 'Rename artifact presentation without changing immutable revisions',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        body: RenameArtifactBodySchema,
        response: { 200: ArtifactSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      const body = request.body as { name: string };
      return lifecycle.renameArtifact({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        name: body.name,
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/artifacts/:artifactId/restores',
    {
      schema: {
        operationId: 'restoreArtifactRevisionV1',
        summary: 'Restore an immutable revision as a new latest revision',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['artifacts'],
        params: WorkspaceArtifactParamsSchema,
        headers: IdempotencyHeadersSchema,
        body: RestoreArtifactBodySchema,
        response: { 201: RestoreResultSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string; artifactId: string };
      const headers = request.headers as { 'idempotency-key': string };
      const body = request.body as { sourceRevisionId: string };
      const result = await lifecycle.restoreArtifact({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        sourceRevisionId: body.sourceRevisionId,
        idempotencyKey: headers['idempotency-key'],
        requestId: request.id,
        signal: requestCancellationSignal(request, reply),
      });
      return reply.status(201).send(result);
    },
  );
}
