import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shelf-folder-api-'));
  roots.push(root);
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'installation-main', actorId: 'actor-agent' };
      },
    },
    authorizer: { async authorize() {} },
  });
  apps.push(app);
  return app;
}

function folderMultipart() {
  const boundary = 'shelf-folder-boundary';
  const manifest = {
    version: 'shelf-folder-manifest/v1',
    rootName: 'Project',
    entries: [
      { path: 'docs', kind: 'directory' },
      { path: 'docs/README.md', kind: 'file', mediaType: 'text/markdown' },
      { path: 'empty', kind: 'directory' },
      { path: 'index.html', kind: 'file', mediaType: 'text/html' },
    ],
  };
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="publisherMetadata"\r\n\r\n',
      '{"source":"api-test"}\r\n',
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="manifest"\r\n\r\n',
      `${JSON.stringify(manifest)}\r\n`,
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="ignored-one"\r\n',
      'Content-Type: application/octet-stream\r\n\r\n',
      '# Shelf\r\n',
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="ignored-two"\r\n',
      'Content-Type: application/octet-stream\r\n\r\n',
      '<h1>Shelf</h1>\r\n',
      `--${boundary}--\r\n`,
    ].join(''),
  };
}

describe('folder snapshot HTTP API', () => {
  it('publishes, pages, and restores one atomic portable tree', async () => {
    const app = await fixture();
    const body = folderMultipart();
    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/folders',
      headers: {
        ...body.headers,
        authorization: 'Bearer test',
        'idempotency-key': 'folder-1',
      },
      payload: body.payload,
    });

    expect(published.statusCode).toBe(201);
    expect(published.json()).toMatchObject({
      kind: 'folder',
      workspaceId: 'workspace-main',
      byteCount: 21,
      fileCount: 2,
      publisherMetadata: { source: 'api-test' },
      replayed: false,
    });
    const artifactId = published.json().artifactId as string;
    const revisionId = published.json().revisionId as string;
    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${revisionId}/tree?limit=100`,
      headers: { authorization: 'Bearer test' },
    });

    expect(tree.statusCode).toBe(200);
    expect(tree.json()).toMatchObject({
      revisionId,
      byteCount: 21,
      fileCount: 2,
      items: [
        { path: 'docs', kind: 'directory' },
        { path: 'docs/README.md', kind: 'file', byteCount: 7 },
        { path: 'empty', kind: 'directory' },
        { path: 'index.html', kind: 'file', byteCount: 14 },
      ],
      nextCursor: null,
    });

    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/restores`,
      headers: {
        authorization: 'Bearer test',
        'idempotency-key': 'restore-folder-1',
        'content-type': 'application/json',
      },
      payload: { sourceRevisionId: revisionId },
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      kind: 'folder',
      artifactId,
      sourceRevisionId: revisionId,
      revisionNumber: 2,
      contentHash: published.json().contentHash,
      byteCount: 21,
      fileCount: 2,
      paths: { tree: expect.stringMatching(/\/tree$/u) },
    });
    const restoredTree = await app.inject({
      method: 'GET',
      url: `${restored.json().paths.tree}?limit=100`,
      headers: { authorization: 'Bearer test' },
    });
    expect(restoredTree.statusCode).toBe(200);
    expect(restoredTree.json().items).toEqual(tree.json().items);
  });
});
