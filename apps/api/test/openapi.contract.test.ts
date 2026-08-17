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
  });

  it('matches the checked generated contract', async () => {
    const checked = await readFile(new URL('../openapi/v1.json', import.meta.url), 'utf8');
    expect(JSON.parse(checked)).toEqual(app.swagger());
  });
});
