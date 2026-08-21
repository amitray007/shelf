import {
  AccessCredentialNotFoundError,
  type DashboardAccessService,
  DashboardGrantDeniedError,
  InvalidCredentialPageError,
  InvalidWorkspaceIdError,
  type ManagedAccessCredentialSummary,
  OwnerGrantDeniedError,
  WorkspaceAlreadyExistsError,
  WorkspaceNotEmptyError,
  WorkspaceNotFoundError,
} from '@shelf/auth';
import {
  DashboardCredentialIssueRequestSchema,
  WORKSPACE_ID_PATTERN,
  WorkspaceCreateRequestSchema,
} from '@shelf/contracts';
import { AuthorizationDeniedError, ShelfCoreError } from '@shelf/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from 'typebox';

import type { Authenticator } from '../authenticate.js';
import { authenticateHumanSession } from '../authenticate.js';

const PageQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
const CredentialParamsSchema = Type.Object(
  { credentialId: Type.String({ pattern: '^crd_[A-Za-z0-9_-]{22}$' }) },
  { additionalProperties: false },
);
const WorkspaceParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128, pattern: WORKSPACE_ID_PATTERN }) },
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
const workspaceDeletionErrors = { ...errors, 409: Type.Ref('ErrorEnvelope') };

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
  if (error instanceof InvalidWorkspaceIdError) {
    throw new ShelfCoreError('INVALID_REQUEST', 'The workspace ID is invalid.', {
      retryable: false,
      details: [{ field: 'workspaceId', reason: 'invalid' }],
    });
  }
  if (error instanceof WorkspaceAlreadyExistsError) {
    throw new ShelfCoreError(
      'WORKSPACE_ALREADY_EXISTS',
      'A workspace with this ID already exists.',
      {
        retryable: false,
        details: [{ field: 'workspaceId', reason: 'duplicate' }],
      },
    );
  }
  if (error instanceof WorkspaceNotEmptyError) {
    throw new ShelfCoreError(
      'WORKSPACE_NOT_EMPTY',
      'This workspace still holds artifacts. Delete them first, then delete the workspace.',
      { retryable: false, details: [{ field: 'workspaceId', reason: 'not-empty' }] },
    );
  }
  // A held owner grant without a workspace row is a race or a stale grant; the
  // dashboard never distinguishes that from a workspace the actor cannot reach.
  if (error instanceof WorkspaceNotFoundError) throw new AuthorizationDeniedError();
  if (error instanceof OwnerGrantDeniedError) throw new AuthorizationDeniedError();
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

  app.post(
    '/api/v1/workspaces',
    {
      schema: {
        operationId: 'createWorkspaceV1',
        summary: 'Create an isolated workspace and grant the owner publish and read actions',
        security: [{ cookieAuth: [] }],
        tags: ['dashboard'],
        body: WorkspaceCreateRequestSchema,
        response: { 201: Type.Ref('WorkspaceCreateResult'), ...errors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const body = request.body as { workspaceId: string };
      try {
        return reply.status(201).send({
          apiVersion: 'v1',
          ...(await dependencies.access.createWorkspace({
            installationId: identity.installationId,
            actorId: identity.actorId,
            workspaceId: body.workspaceId,
          })),
        });
      } catch (error) {
        mapDashboardError(error);
      }
    },
  );

  app.delete(
    '/api/v1/workspaces/:workspaceId',
    {
      schema: {
        operationId: 'deleteWorkspaceV1',
        summary: 'Idempotently delete one empty workspace the owner controls',
        security: [{ cookieAuth: [] }],
        tags: ['dashboard'],
        params: WorkspaceParamsSchema,
        response: { 200: Type.Ref('WorkspaceDeleteResult'), ...workspaceDeletionErrors },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const identity = await authenticateHumanSession(request, dependencies.authenticator);
      const params = request.params as { workspaceId: string };
      try {
        return {
          apiVersion: 'v1' as const,
          ...(await dependencies.access.deleteWorkspace({
            installationId: identity.installationId,
            actorId: identity.actorId,
            workspaceId: params.workspaceId,
          })),
        };
      } catch (error) {
        mapDashboardError(error);
      }
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
      const query = request.query as { limit?: number; cursor?: string; workspaceId?: string };
      try {
        const page = await dependencies.access.list({
          installationId: identity.installationId,
          actorId: identity.actorId,
          limit: query.limit ?? 20,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
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
