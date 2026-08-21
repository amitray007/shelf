import type { DashboardAccessService } from '@shelf/auth';
import {
  InvalidWorkspaceIdError,
  OwnerGrantDeniedError,
  WorkspaceNotEmptyError,
  WorkspaceNotFoundError,
} from '@shelf/auth';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createShelfApp } from '../src/app.js';
import type { AuthenticationContext } from '../src/authenticate.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function accessService(): DashboardAccessService {
  return {
    session: vi.fn(async () => ({ actorId: 'act_owner', workspaces: [] })),
    issue: vi.fn(async () => {
      throw new Error('unused');
    }),
    list: vi.fn(async () => ({ items: [] })),
    revoke: vi.fn(async () => {
      throw new Error('unused');
    }),
    createWorkspace: vi.fn(async (input) => ({
      workspaceId: input.workspaceId,
      actions: ['file.publish', 'revision.read'] as const,
    })),
    deleteWorkspace: vi.fn(async (input) => ({
      workspaceId: input.workspaceId,
      deleted: true as const,
      alreadyDeleted: false,
    })),
  };
}

async function fixture(
  identity: AuthenticationContext | undefined,
  dashboardAccess = accessService(),
) {
  const app = await createShelfApp({
    stagingRoot: '/tmp/shelf-workspace-deletion-api-test',
    authenticator: {
      async authenticate() {
        return identity;
      },
    },
    authorizer: { async authorize() {} },
    dashboardAccess,
  });
  apps.push(app);
  return { app, dashboardAccess };
}

const owner: AuthenticationContext = {
  installationId: 'installation-main',
  actorId: 'act_owner',
  authenticationMethod: 'human-session',
};

describe('DELETE /api/v1/workspaces/:workspaceId', () => {
  it('deletes an empty workspace for its owner without caching the confirmation', async () => {
    const { app, dashboardAccess } = await fixture(owner);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/workspace-main',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      deleted: true,
      alreadyDeleted: false,
    });
    expect(dashboardAccess.deleteWorkspace).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorId: 'act_owner',
      workspaceId: 'workspace-main',
    });
  });

  it('reports an already-deleted workspace as success rather than an error', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.deleteWorkspace).mockResolvedValueOnce({
      workspaceId: 'workspace-main',
      deleted: true,
      alreadyDeleted: true,
    });
    const { app } = await fixture(owner, dashboardAccess);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/workspace-main',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      deleted: true,
      alreadyDeleted: true,
    });
  });

  it('refuses a workspace that still holds active artifacts with a 409 the user can act on', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.deleteWorkspace).mockRejectedValueOnce(new WorkspaceNotEmptyError());
    const { app } = await fixture(owner, dashboardAccess);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/workspace-main',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'WORKSPACE_NOT_EMPTY',
        retryable: false,
        details: [{ field: 'workspaceId', reason: 'not-empty' }],
      },
    });
    expect(response.json().error.message).toMatch(/delete them first/i);
  });

  it('denies an actor that does not hold both owner actions', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.deleteWorkspace).mockRejectedValueOnce(new OwnerGrantDeniedError());
    const { app } = await fixture(owner, dashboardAccess);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/workspace-other',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
  });

  it('hides an unknown workspace behind the same authorization refusal', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.deleteWorkspace).mockRejectedValueOnce(new WorkspaceNotFoundError());
    const { app } = await fixture(owner, dashboardAccess);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/workspace-gone',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
  });

  it('rejects a malformed workspace ID before reaching the service', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.deleteWorkspace).mockRejectedValueOnce(new InvalidWorkspaceIdError());
    const { app } = await fixture(owner, dashboardAccess);
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/-not-valid',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(dashboardAccess.deleteWorkspace).not.toHaveBeenCalled();
  });
});
