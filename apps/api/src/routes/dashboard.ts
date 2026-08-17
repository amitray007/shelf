import {
  AccessCredentialNotFoundError,
  type DashboardAccessService,
  DashboardGrantDeniedError,
  InvalidCredentialPageError,
  type ManagedAccessCredentialSummary,
} from '@shelf/auth';
import { DashboardCredentialIssueRequestSchema } from '@shelf/contracts';
import { AuthorizationDeniedError, ShelfCoreError } from '@shelf/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

import type { Authenticator } from '../authenticate.js';
import { authenticateHumanSession } from '../authenticate.js';

const PageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const CredentialParamsSchema = Type.Object(
  { credentialId: Type.String({ pattern: '^crd_[A-Za-z0-9_-]{22}$' }) },
  { additionalProperties: false },
);
const errors = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};

function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

function nullableDate(value: Date | undefined): string | null {
  return value?.toISOString() ?? null;
}

function summary(value: ManagedAccessCredentialSummary) {
  return {
    credentialId: value.credentialId,
    actorId: value.actorId,
    actorName: value.actorName,
    createdAt: value.createdAt.toISOString(),
    expiresAt: nullableDate(value.expiresAt),
    revokedAt: nullableDate(value.revokedAt),
    lastUsedAt: nullableDate(value.lastUsedAt),
    grants: value.grants,
  };
}

function mapDashboardError(error: unknown): never {
  if (error instanceof DashboardGrantDeniedError) throw new AuthorizationDeniedError();
  if (error instanceof InvalidCredentialPageError) {
    throw new ShelfCoreError('INVALID_REQUEST', 'The credential page cursor is invalid.', {
      retryable: false,
      details: [{ field: 'cursor', reason: 'invalid' }],
    });
  }
  if (error instanceof AccessCredentialNotFoundError) {
    throw new ShelfCoreError(
      'ACCESS_CREDENTIAL_NOT_FOUND',
      'The access credential was not found.',
      { retryable: false },
    );
  }
  throw error;
}

function optionalExpiry(value: string | null | undefined): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const expiresAt = new Date(value);
  if (!Number.isFinite(expiresAt.valueOf()) || expiresAt.toISOString() !== value) {
    throw new ShelfCoreError('INVALID_REQUEST', 'The credential expiry is invalid.', {
      retryable: false,
      details: [{ field: 'expiresAt', reason: 'invalid' }],
    });
  }
  return expiresAt;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  dependencies: { authenticator: Authenticator; access: DashboardAccessService },
): void {
  app.get(
    '/api/v1/dashboard/session',
    {
      schema: {
        operationId: 'getDashboardSessionV1',
        summary: 'Discover the human actor and its authorized workspaces',
        security: [{ cookieAuth: [] }],
        tags: ['dashboard'],
        response: { 200: Type.Ref('DashboardSession'), ...errors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const session = await dependencies.access.session({
        installationId: identity.installationId,
        actorId: identity.actorId,
      });
      return { apiVersion: 'v1' as const, ...session };
    },
  );

  app.get(
    '/api/v1/access-credentials',
    {
      schema: {
        operationId: 'listDashboardCredentialsV1',
        summary: 'List installation credentials without secret material',
        security: [{ cookieAuth: [] }],
        tags: ['access'],
        querystring: PageQuerySchema,
        response: { 200: Type.Ref('DashboardCredentialPage'), ...errors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const query = request.query as { limit?: number; cursor?: string };
      try {
        const page = await dependencies.access.list({
          installationId: identity.installationId,
          actorId: identity.actorId,
          limit: query.limit ?? 20,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return {
          apiVersion: 'v1' as const,
          items: page.items.map(summary),
          nextCursor: page.nextCursor ?? null,
        };
      } catch (error) {
        mapDashboardError(error);
      }
    },
  );

  app.post(
    '/api/v1/access-credentials',
    {
      schema: {
        operationId: 'issueDashboardCredentialV1',
        summary: 'Issue one scoped access credential and reveal its token once',
        security: [{ cookieAuth: [] }],
        tags: ['access'],
        body: DashboardCredentialIssueRequestSchema,
        response: { 201: Type.Ref('DashboardCredentialIssue'), ...errors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const body = request.body as {
        actorName: string;
        grants: Array<{ workspaceId: string; action: 'file.publish' | 'revision.read' }>;
        expiresAt?: string | null;
      };
      try {
        const expiresAt = optionalExpiry(body.expiresAt);
        const issued = await dependencies.access.issue({
          installationId: identity.installationId,
          actorId: identity.actorId,
          actorName: body.actorName,
          grants: body.grants,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        });
        return reply.status(201).send({
          apiVersion: 'v1',
          credentialId: issued.credentialId,
          actorId: issued.actorId,
          actorName: issued.actorName,
          token: issued.token,
          expiresAt: nullableDate(issued.expiresAt),
          grants: issued.grants,
        });
      } catch (error) {
        mapDashboardError(error);
      }
    },
  );

  app.delete(
    '/api/v1/access-credentials/:credentialId',
    {
      schema: {
        operationId: 'revokeDashboardCredentialV1',
        summary: 'Idempotently revoke one installation credential',
        security: [{ cookieAuth: [] }],
        tags: ['access'],
        params: CredentialParamsSchema,
        response: { 200: Type.Ref('DashboardCredentialRevoke'), ...errors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const params = request.params as { credentialId: string };
      try {
        return {
          apiVersion: 'v1' as const,
          ...(await dependencies.access.revoke({
            installationId: identity.installationId,
            actorId: identity.actorId,
            credentialId: params.credentialId,
          })),
        };
      } catch (error) {
        mapDashboardError(error);
      }
    },
  );
}
