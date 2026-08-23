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

function folderMultipart({ readme = '# Shelf', index = '<h1>Shelf</h1>' } = {}) {
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
      `${readme}\r\n`,
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="ignored-two"\r\n',
      'Content-Type: application/octet-stream\r\n\r\n',
      `${index}\r\n`,
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
    const comments = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments?currentRevisionId=${revisionId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(comments.statusCode, comments.body).toBe(200);
    expect(comments.json()).toMatchObject({ items: [], nextCursor: null });
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
    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${revisionId}/tree/content?path=${encodeURIComponent('docs/README.md')}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('text/markdown');
    expect(file.rawPayload.toString()).toBe('# Shelf');

    const fileRange = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${revisionId}/tree/content?path=${encodeURIComponent('docs/README.md')}`,
      headers: { authorization: 'Bearer test', range: 'bytes=2-4' },
    });
    const filePreview = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${revisionId}/tree/content/preview?path=${encodeURIComponent('docs/README.md')}`,
      headers: { authorization: 'Bearer test', range: 'bytes=-3' },
    });
    expect(fileRange.statusCode).toBe(206);
    expect(fileRange.rawPayload.toString()).toBe('She');
    expect(fileRange.headers).toMatchObject({
      'content-range': 'bytes 2-4/7',
      'content-disposition': expect.stringMatching(/^attachment;/u),
    });
    expect(filePreview.statusCode).toBe(206);
    expect(filePreview.rawPayload.toString()).toBe('elf');
    expect(filePreview.headers).toMatchObject({
      'content-range': 'bytes 4-6/7',
      'content-disposition': expect.stringMatching(/^inline;/u),
      'content-type': 'text/markdown',
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

  it('creates an immutable new folder revision when one file changes', async () => {
    const app = await fixture();
    const initial = folderMultipart();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/folders',
      headers: {
        ...initial.headers,
        authorization: 'Bearer test',
        'idempotency-key': 'folder-revision-1',
      },
      payload: initial.payload,
    });
    expect(first.statusCode).toBe(201);
    const artifactId = first.json().artifactId as string;
    const firstRevisionId = first.json().revisionId as string;

    const updated = folderMultipart({ readme: '# Updated' });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/folders/${artifactId}/revisions`,
      headers: {
        ...updated.headers,
        authorization: 'Bearer test',
        'idempotency-key': 'folder-revision-2',
      },
      payload: updated.payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({
      artifactId,
      kind: 'folder',
    });
    const secondRevisionId = second.json().revisionId as string;
    expect(secondRevisionId).not.toBe(firstRevisionId);

    const revisions = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/revisions?limit=10`,
      headers: { authorization: 'Bearer test' },
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ revisionId: firstRevisionId, revisionNumber: 1 }),
        expect.objectContaining({ revisionId: secondRevisionId, revisionNumber: 2 }),
      ]),
    );

    const oldFile = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${firstRevisionId}/tree/content?path=${encodeURIComponent('docs/README.md')}`,
      headers: { authorization: 'Bearer test' },
    });
    const newFile = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${secondRevisionId}/tree/content?path=${encodeURIComponent('docs/README.md')}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(oldFile.statusCode).toBe(200);
    expect(oldFile.rawPayload.toString()).toBe('# Shelf');
    expect(newFile.statusCode).toBe(200);
    expect(newFile.rawPayload.toString()).toBe('# Updated');

    const unchangedFile = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${secondRevisionId}/tree/content?path=${encodeURIComponent('index.html')}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(unchangedFile.statusCode).toBe(200);
    expect(unchangedFile.rawPayload.toString()).toBe('<h1>Shelf</h1>');
  });
});
