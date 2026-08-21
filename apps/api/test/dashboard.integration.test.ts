import type { DashboardAccessService } from '@shelf/auth';
import {
  AccessCredentialNotFoundError,
  DashboardGrantDeniedError,
  InvalidCredentialPageError,
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
    session: vi.fn(async () => ({
      actorId: 'act_owner',
      workspaces: [{ workspaceId: 'workspace-main', actions: ['file.publish', 'revision.read'] }],
    })),
    issue: vi.fn(async (input) => ({
      actorId: 'act_agent',
      credentialId: `crd_${'a'.repeat(22)}`,
      token: `shf_v1.${'b'.repeat(22)}.${'c'.repeat(43)}`,
      actorName: input.actorName,
      grants: input.grants,
    })),
    list: vi.fn(async () => ({
      items: [
        {
          credentialId: `crd_${'a'.repeat(22)}`,
          actorId: 'act_agent',
          actorName: 'release-agent',
          createdAt: new Date('2026-08-18T00:00:00.000Z'),
          grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
        },
      ],
    })),
    revoke: vi.fn(async (input) => ({
      credentialId: input.credentialId,
      revoked: true as const,
      alreadyRevoked: false,
    })),
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
    stagingRoot: '/tmp/shelf-dashboard-api-test',
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

describe('dashboard HTTP API', () => {
  it('requires a human session for every dashboard authority route', async () => {
    const anonymous = await fixture(undefined);
    expect(
      (await anonymous.app.inject({ method: 'GET', url: '/api/v1/dashboard/session' })).statusCode,
    ).toBe(401);
    expect(
      (
        await anonymous.app.inject({
          method: 'POST',
          url: '/api/v1/workspaces',
          payload: { workspaceId: 'workspace-work' },
        })
      ).statusCode,
    ).toBe(401);

    const bearer = await fixture({
      installationId: 'installation-main',
      actorId: 'act_agent',
      authenticationMethod: 'access-credential',
    });
    for (const request of [
      { method: 'GET' as const, url: '/api/v1/dashboard/session' },
      { method: 'GET' as const, url: '/api/v1/access-credentials' },
      {
        method: 'POST' as const,
        url: '/api/v1/access-credentials',
        payload: {
          actorName: 'agent',
          grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
        },
      },
      { method: 'DELETE' as const, url: `/api/v1/access-credentials/crd_${'a'.repeat(22)}` },
      {
        method: 'POST' as const,
        url: '/api/v1/workspaces',
        payload: { workspaceId: 'workspace-work' },
      },
      { method: 'DELETE' as const, url: '/api/v1/workspaces/workspace-main' },
    ]) {
      const response = await bearer.app.inject(request);
      expect(response.statusCode).toBe(403);
    }
    expect(bearer.dashboardAccess.session).not.toHaveBeenCalled();
    expect(bearer.dashboardAccess.issue).not.toHaveBeenCalled();
    expect(bearer.dashboardAccess.list).not.toHaveBeenCalled();
    expect(bearer.dashboardAccess.revoke).not.toHaveBeenCalled();
    expect(bearer.dashboardAccess.createWorkspace).not.toHaveBeenCalled();
    expect(bearer.dashboardAccess.deleteWorkspace).not.toHaveBeenCalled();
  });

  it('discovers workspaces and manages credentials with no-store responses', async () => {
    const { app, dashboardAccess } = await fixture({
      installationId: 'installation-main',
      actorId: 'act_owner',
      authenticationMethod: 'human-session',
    });
    const session = await app.inject({ method: 'GET', url: '/api/v1/dashboard/session' });
    expect(session.statusCode).toBe(200);
    expect(session.headers['cache-control']).toBe('no-store');
    expect(session.json()).toEqual({
      apiVersion: 'v1',
      actorId: 'act_owner',
      workspaces: [{ workspaceId: 'workspace-main', actions: ['file.publish', 'revision.read'] }],
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { workspaceId: 'workspace-work' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-work',
      actions: ['file.publish', 'revision.read'],
    });
    expect(dashboardAccess.createWorkspace).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorId: 'act_owner',
      workspaceId: 'workspace-work',
    });

    const issued = await app.inject({
      method: 'POST',
      url: '/api/v1/access-credentials',
      payload: {
        actorName: 'release-agent',
        grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
        expiresAt: null,
      },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers['cache-control']).toBe('no-store');
    expect(issued.json()).toMatchObject({
      apiVersion: 'v1',
      actorName: 'release-agent',
      expiresAt: null,
      token: expect.stringMatching(/^shf_v1\./),
    });
    expect(dashboardAccess.issue).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorId: 'act_owner',
      actorName: 'release-agent',
      grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/access-credentials?limit=20&workspaceId=workspace-main',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      apiVersion: 'v1',
      items: [
        {
          credentialId: `crd_${'a'.repeat(22)}`,
          actorId: 'act_agent',
          actorName: 'release-agent',
          createdAt: '2026-08-18T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(listed.json())).not.toContain('shf_v1.');
    expect(dashboardAccess.list).toHaveBeenCalledWith({
      installationId: 'installation-main',
      actorId: 'act_owner',
      limit: 20,
      workspaceId: 'workspace-main',
    });

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/access-credentials/crd_${'a'.repeat(22)}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({
      apiVersion: 'v1',
      credentialId: `crd_${'a'.repeat(22)}`,
      revoked: true,
      alreadyRevoked: false,
    });
  });

  it('uses canonical non-secret errors for denied grants and missing credentials', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.issue).mockRejectedValueOnce(new DashboardGrantDeniedError());
    vi.mocked(dashboardAccess.revoke).mockRejectedValueOnce(new AccessCredentialNotFoundError());
    const { app } = await fixture(
      {
        installationId: 'installation-main',
        actorId: 'act_owner',
        authenticationMethod: 'human-session',
      },
      dashboardAccess,
    );
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/access-credentials',
      payload: {
        actorName: 'overreach',
        grants: [{ workspaceId: 'workspace-other', action: 'revision.read' }],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
    expect(JSON.stringify(denied.json())).not.toContain('shf_v1.');

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/v1/access-credentials/crd_${'z'.repeat(22)}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'ACCESS_CREDENTIAL_NOT_FOUND' } });
    expect(JSON.stringify(missing.json())).not.toContain('shf_v1.');
  });

  it('rejects malformed cursors and impossible expiration instants canonically', async () => {
    const dashboardAccess = accessService();
    vi.mocked(dashboardAccess.list).mockRejectedValueOnce(new InvalidCredentialPageError());
    const { app } = await fixture(
      {
        installationId: 'installation-main',
        actorId: 'act_owner',
        authenticationMethod: 'human-session',
      },
      dashboardAccess,
    );

    const cursor = await app.inject({
      method: 'GET',
      url: '/api/v1/access-credentials?cursor=not-a-cursor',
    });
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: [{ field: 'cursor', reason: 'invalid' }] },
    });

    const expiry = await app.inject({
      method: 'POST',
      url: '/api/v1/access-credentials',
      payload: {
        actorName: 'time-traveler',
        grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
        expiresAt: '2026-02-31T00:00:00.000Z',
      },
    });
    expect(expiry.statusCode).toBe(400);
    expect(expiry.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', details: [{ field: 'expiresAt', reason: 'invalid' }] },
    });
    expect(dashboardAccess.issue).not.toHaveBeenCalled();
  });
});
