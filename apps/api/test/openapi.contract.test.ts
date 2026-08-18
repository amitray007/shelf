import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createShelfApp({
    stagingRoot: '/tmp/shelf-openapi-contract',
    authenticator: { async authenticate() {} },
    authorizer: { async authorize() {} },
    dashboardAccess: {
      async session() {
        return { actorId: 'actor-openapi', workspaces: [] };
      },
      async list() {
        return { items: [] };
      },
      async issue() {
        throw new Error('OpenAPI fixture does not issue credentials.');
      },
      async revoke() {
        throw new Error('OpenAPI fixture does not revoke credentials.');
      },
      async createWorkspace() {
        throw new Error('OpenAPI fixture does not create workspaces.');
      },
    },
  });
});

afterAll(async () => {
  await app.close();
});

describe('OpenAPI v1', () => {
  it('contains the stable streamed publish operation and canonical responses', () => {
    const document = app.swagger();
    const serialized = JSON.stringify(document);

    expect(document.openapi).toBe('3.1.0');
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces/{workspaceId}/artifacts', 'post', 'operationId'],
      'publishFileV1',
    );
    expect(document).toHaveProperty(
      [
        'paths',
        '/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/revisions',
        'post',
        'operationId',
      ],
      'publishArtifactRevisionV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces/{workspaceId}/artifacts', 'get', 'operationId'],
      'listArtifactsV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/artifacts/{artifactId}', 'get', 'operationId'],
      'getArtifactV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/artifacts/{artifactId}/revisions', 'get', 'operationId'],
      'listArtifactRevisionsV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/artifacts/{artifactId}', 'patch', 'operationId'],
      'renameArtifactV1',
    );
    expect(document).toHaveProperty(
      [
        'paths',
        '/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/restores',
        'post',
        'operationId',
      ],
      'restoreArtifactRevisionV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces/{workspaceId}/folders', 'post', 'operationId'],
      'publishFolderV1',
    );
    expect(document).toHaveProperty(
      [
        'paths',
        '/api/v1/workspaces/{workspaceId}/folders/{artifactId}/revisions',
        'post',
        'operationId',
      ],
      'publishFolderRevisionV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/revisions/{revisionId}/tree', 'get', 'operationId'],
      'getFolderTreeV1',
    );
    expect(document).toHaveProperty(
      [
        'paths',
        '/api/v1/revisions/{baseRevisionId}/comparisons/{targetRevisionId}',
        'get',
        'operationId',
      ],
      'compareRevisionsV1',
    );
    expect(serialized).toContain('multipart/form-data');
    expect(serialized).toContain('PublishResult');
    expect(serialized).toContain('ErrorEnvelope');
    expect(serialized).toContain('revision.restore');
    expect(document).toHaveProperty(
      ['paths', '/api/v1/revisions/{revisionId}/content', 'get', 'operationId'],
      'downloadRevisionContentV1',
    );
    expect(document).toHaveProperty([
      'paths',
      '/api/v1/revisions/{revisionId}/content',
      'get',
      'responses',
      '206',
    ]);
    expect(document).toHaveProperty([
      'paths',
      '/api/v1/revisions/{revisionId}/content',
      'get',
      'responses',
      '304',
    ]);
    expect(document).toHaveProperty([
      'paths',
      '/api/v1/revisions/{revisionId}/content',
      'get',
      'responses',
      '416',
    ]);
    expect(document).toHaveProperty([
      'paths',
      '/api/v1/revisions/{revisionId}/content',
      'get',
      'responses',
      '206',
      'headers',
      'Content-Range',
    ]);
    expect(document).toHaveProperty([
      'paths',
      '/api/v1/revisions/{revisionId}/content',
      'get',
      'responses',
      '200',
      'content',
      'application/octet-stream',
    ]);
    expect(serialized).toContain('if-none-match');
    expect(document).toHaveProperty(
      [
        'paths',
        '/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/shares',
        'post',
        'operationId',
      ],
      'createShareV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces/{workspaceId}/shares', 'get', 'operationId'],
      'listSharesV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces/{workspaceId}/shares/{shareId}', 'delete', 'operationId'],
      'revokeShareV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/public/config', 'get', 'operationId'],
      'getPublicClientConfigV1',
    );
    for (const [path, operationId] of [
      ['/api/v1/public/shares/{shareId}/resolve', 'resolvePublicShareV1'],
      ['/api/v1/public/shares/{shareId}/content', 'downloadPublicShareContentV1'],
      ['/api/v1/public/shares/{shareId}/tree', 'getPublicShareTreeV1'],
    ] as const) {
      expect(document).toHaveProperty(['paths', path, 'post', 'operationId'], operationId);
      const operation = document.paths?.[path]?.post;
      expect(operation?.security).toBeUndefined();
      expect(JSON.stringify(operation?.parameters ?? [])).not.toContain('secret');
      expect(JSON.stringify(operation?.requestBody ?? {})).toContain('secret');
    }
    expect(
      document.paths?.['/api/v1/public/shares/{shareId}/content']?.post?.requestBody?.content,
    ).toHaveProperty('application/x-www-form-urlencoded');
    expect(document).toHaveProperty(
      ['paths', '/api/v1/dashboard/session', 'get', 'operationId'],
      'getDashboardSessionV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/access-credentials', 'get', 'operationId'],
      'listDashboardCredentialsV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/access-credentials', 'post', 'operationId'],
      'issueDashboardCredentialV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/access-credentials/{credentialId}', 'delete', 'operationId'],
      'revokeDashboardCredentialV1',
    );
    expect(document).toHaveProperty(
      ['paths', '/api/v1/workspaces', 'post', 'operationId'],
      'createWorkspaceV1',
    );
    expect(document.paths?.['/api/v1/workspaces']?.post?.security).toEqual([{ cookieAuth: [] }]);
    for (const [path, method] of [
      ['/api/v1/workspaces/{workspaceId}/artifacts', 'get'],
      ['/api/v1/artifacts/{artifactId}', 'get'],
      ['/api/v1/artifacts/{artifactId}', 'patch'],
      ['/api/v1/artifacts/{artifactId}/revisions', 'get'],
      ['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/restores', 'post'],
      ['/api/v1/revisions/{revisionId}/content', 'get'],
      ['/api/v1/revisions/{revisionId}/tree', 'get'],
      ['/api/v1/revisions/{baseRevisionId}/comparisons/{targetRevisionId}', 'get'],
      ['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/shares', 'post'],
      ['/api/v1/workspaces/{workspaceId}/shares', 'get'],
      ['/api/v1/workspaces/{workspaceId}/shares/{shareId}', 'delete'],
    ] as const) {
      expect(document.paths?.[path]?.[method]?.security).toEqual([
        { bearerAuth: [] },
        { cookieAuth: [] },
      ]);
    }
  });

  it('matches the checked generated contract', async () => {
    const checked = await readFile(new URL('../openapi/v1.json', import.meta.url), 'utf8');
    expect(JSON.parse(checked)).toEqual(app.swagger());
  });
});
