import {
  ArtifactPageSchema,
  ArtifactRevisionPageSchema,
  ArtifactSchema,
  OpaqueArtifactIdSchema,
} from '@shelf/contracts';
import { createArtifactCatalogService } from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';

const ArtifactParamsSchema = Type.Object(
  { artifactId: OpaqueArtifactIdSchema },
  { additionalProperties: false },
);

const WorkspaceParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);

const PageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

const errorResponses = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
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

  app.get(
    '/api/v1/workspaces/:workspaceId/artifacts',
    {
      schema: {
        operationId: 'listArtifactsV1',
        summary: 'List artifacts in one workspace',
        security: [{ bearerAuth: [] }],
        tags: ['artifacts'],
        params: WorkspaceParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: ArtifactPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      const query = request.query as { limit?: number; cursor?: string };
      return catalog.listArtifacts({
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
    '/api/v1/artifacts/:artifactId',
    {
      schema: {
        operationId: 'getArtifactV1',
        summary: 'Get one artifact and its latest revision',
        security: [{ bearerAuth: [] }],
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
        summary: 'List one artifact revision history newest first',
        security: [{ bearerAuth: [] }],
        tags: ['artifacts'],
        params: ArtifactParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: ArtifactRevisionPageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { artifactId: string };
      const query = request.query as { limit?: number; cursor?: string };
      return catalog.listArtifactRevisions({
        installationId: identity.installationId,
        actorId: identity.actorId,
        artifactId: params.artifactId,
        limit: query.limit ?? 20,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );
}
