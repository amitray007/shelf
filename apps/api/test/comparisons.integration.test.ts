import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ContentReader, createFolderPublishService, createPublishService } from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryRevisionRepository } from '../src/adapters/memory-revision-repository.js';
import { TemporaryContentStore } from '../src/adapters/temporary-content-store.js';
import { createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('revision comparison HTTP API', () => {
  it('compares two file revisions from descriptors without opening content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-comparison-api-'));
    roots.push(root);
    const repository = new MemoryRevisionRepository();
    const store = new TemporaryContentStore(root);
    let contentReads = 0;
    const reader: ContentReader = {
      async read(content, options) {
        contentReads += 1;
        return store.read(content, options);
      },
    };
    const authorizer = { async authorize() {} };
    const app = await createShelfApp({
      authenticator: {
        async authenticate() {
          return { installationId: 'installation-main', actorId: 'actor-reader' };
        },
      },
      authorizer,
      contentStore: store,
      contentReader: reader,
      revisionRepository: repository,
    });
    apps.push(app);
    const publish = createPublishService({
      authorizer,
      artifactRepository: repository,
      contentStore: store,
      revisionRepository: repository,
    });
    const bytes = (value: string) =>
      (async function* content() {
        yield new TextEncoder().encode(value);
      })();
    const base = await publish({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      requestId: 'request-base',
      idempotencyKey: 'base',
      originalFileName: 'README.md',
      mediaType: 'text/markdown',
      publisherMetadata: {},
      content: bytes('# Base'),
    });
    const target = await publish({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      requestId: 'request-target',
      idempotencyKey: 'target',
      artifactId: base.artifactId,
      originalFileName: 'README.md',
      mediaType: 'text/markdown',
      publisherMetadata: {},
      content: bytes('# Target'),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${base.revisionId}/comparisons/${target.revisionId}?limit=100`,
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      apiVersion: 'v1',
      kind: 'file',
      artifactId: base.artifactId,
      base: { revisionId: base.revisionId },
      target: { revisionId: target.revisionId },
      status: 'changed',
      changes: { content: true, mediaType: false, originalFileName: false },
    });
    expect(contentReads).toBe(0);
  });

  it('pages folder changes and identifies one exact file move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-comparison-folder-api-'));
    roots.push(root);
    const repository = new MemoryRevisionRepository();
    const store = new TemporaryContentStore(root);
    let contentReads = 0;
    const authorizer = { async authorize() {} };
    const app = await createShelfApp({
      authenticator: {
        async authenticate() {
          return { installationId: 'installation-main', actorId: 'actor-reader' };
        },
      },
      authorizer,
      contentStore: store,
      contentReader: {
        async read(content, options) {
          contentReads += 1;
          return store.read(content, options);
        },
      },
      revisionRepository: repository,
    });
    apps.push(app);
    const publish = createFolderPublishService({
      authorizer,
      artifactRepository: repository,
      contentStore: store,
      folderRepository: repository,
    });
    const file = (value: string) =>
      (async function* content() {
        yield new TextEncoder().encode(value);
      })();
    const base = await publish({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      requestId: 'request-base-folder',
      idempotencyKey: 'base-folder',
      publisherMetadata: {},
      manifest: {
        version: 'shelf-folder-manifest/v1',
        rootName: 'Project',
        entries: [
          { path: 'old.txt', kind: 'file', mediaType: 'text/plain' },
          { path: 'same.txt', kind: 'file', mediaType: 'text/plain' },
        ],
      },
      files: [file('move'), file('base')],
    });
    const target = await publish({
      installationId: 'installation-main',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      requestId: 'request-target-folder',
      idempotencyKey: 'target-folder',
      artifactId: base.artifactId,
      publisherMetadata: {},
      manifest: {
        version: 'shelf-folder-manifest/v1',
        rootName: 'Project',
        entries: [
          { path: 'new.txt', kind: 'file', mediaType: 'text/plain' },
          { path: 'same.txt', kind: 'file', mediaType: 'text/plain' },
        ],
      },
      files: [file('move'), file('target')],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${base.revisionId}/comparisons/${target.revisionId}?limit=1`,
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      kind: 'folder',
      summary: { added: 0, removed: 0, moved: 1, changed: 1, unchanged: 0 },
      items: [{ status: 'moved', fromPath: 'old.txt', toPath: 'new.txt' }],
      nextCursor: expect.any(String),
    });
    expect(contentReads).toBe(0);
  });
});
