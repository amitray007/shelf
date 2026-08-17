import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationDeniedError, type ContentReader, type ContentStore } from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { TemporaryContentStore } from '../src/adapters/temporary-content-store.js';
import { createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function multipart(value: string, filename: string) {
  const boundary = 'shelf-artifact-catalog-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
      'Content-Type: text/plain\r\n\r\n',
      value,
      '\r\n',
      `--${boundary}--\r\n`,
    ].join(''),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shelf-artifact-catalog-'));
  roots.push(root);
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'installation-main', actorId: 'actor-reader' };
      },
    },
    authorizer: { async authorize() {} },
  });
  apps.push(app);
  return app;
}

async function trackedContentFixture() {
  const root = await mkdtemp(join(tmpdir(), 'shelf-artifact-catalog-'));
  roots.push(root);
  const delegate = new TemporaryContentStore(root);
  let mutations = 0;
  const contentStore: ContentStore = {
    async stage(content, options) {
      mutations += 1;
      return delegate.stage(content, options);
    },
    async discard(staged) {
      mutations += 1;
      return delegate.discard(staged);
    },
    async seal(staged, descriptor) {
      mutations += 1;
      return delegate.seal(staged, descriptor);
    },
  };
  const contentReader: ContentReader = {
    read(content, options) {
      return delegate.read(content, options);
    },
  };
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'installation-main', actorId: 'actor-reader' };
      },
    },
    authorizer: { async authorize() {} },
    contentStore,
    contentReader,
  });
  apps.push(app);
  return {
    app,
    get mutations() {
      return mutations;
    },
  };
}

async function publish(
  app: FastifyInstance,
  value: string,
  filename: string,
  key: string,
  artifactId?: string,
) {
  const body = multipart(value, filename);
  return app.inject({
    method: 'POST',
    url:
      artifactId === undefined
        ? '/api/v1/workspaces/workspace-main/artifacts'
        : `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/revisions`,
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': key },
    payload: body.payload,
  });
}

describe('artifact catalog HTTP API', () => {
  it('lists, shows, and pages immutable history after publishing an update', async () => {
    const app = await fixture();
    const created = await publish(app, 'version one', 'README.md', 'artifact-create');
    const artifactId = created.json().artifactId as string;
    const updated = await publish(
      app,
      'version two',
      'CHANGELOG.md',
      'artifact-update',
      artifactId,
    );

    expect(updated.statusCode).toBe(201);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/artifacts?limit=20',
      headers: { authorization: 'Bearer test' },
    });
    const shown = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/revisions?limit=20`,
      headers: { authorization: 'Bearer test' },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      apiVersion: 'v1',
      items: [{ artifactId, latestRevision: { revisionNumber: 2 } }],
      nextCursor: null,
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({
      artifactId,
      latestRevision: {
        revisionId: updated.json().revisionId,
        revisionNumber: 2,
        originalFileName: 'CHANGELOG.md',
      },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      artifactId,
      items: [{ revisionNumber: 2 }, { revisionNumber: 1 }],
      nextCursor: null,
    });
  });

  it('pages workspace artifacts deterministically without duplicates', async () => {
    const app = await fixture();
    await publish(app, 'first artifact', 'first.txt', 'first-artifact');
    await publish(app, 'second artifact', 'second.txt', 'second-artifact');

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/artifacts?limit=1',
      headers: { authorization: 'Bearer test' },
    });
    const firstPage = first.json();
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/workspace-main/artifacts?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      headers: { authorization: 'Bearer test' },
    });
    const secondPage = second.json();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].artifactId).not.toBe(firstPage.items[0].artifactId);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('returns a canonical invalid request for a malformed cursor', async () => {
    const app = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/artifacts?cursor=not%20opaque',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('renames artifact presentation without changing revision identity or filenames', async () => {
    const app = await fixture();
    const created = await publish(app, 'version one', 'README.md', 'rename-create');
    const artifactId = created.json().artifactId as string;
    const revisionId = created.json().revisionId as string;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      payload: { name: 'Project notes' },
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      artifactId,
      name: 'Project notes',
      latestRevision: { revisionId, originalFileName: 'README.md' },
    });
    const pinned = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${revisionId}/content`,
      headers: { authorization: 'Bearer test' },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.rawPayload.toString()).toBe('version one');
  });

  it('rejects an invalid rename without changing the artifact', async () => {
    const app = await fixture();
    const created = await publish(app, 'version one', 'README.md', 'invalid-rename-create');
    const artifactId = created.json().artifactId as string;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      payload: { name: '   ' },
    });
    const shown = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(shown.json()).toMatchObject({ name: 'README.md' });
  });

  it('restores an earlier revision as a new latest revision and replays safely', async () => {
    const tracked = await trackedContentFixture();
    const { app } = tracked;
    const created = await publish(app, 'version one', 'version-one.txt', 'restore-create');
    const artifactId = created.json().artifactId as string;
    const sourceRevisionId = created.json().revisionId as string;
    await publish(app, 'version two', 'version-two.txt', 'restore-update-two', artifactId);
    await publish(app, 'version three', 'version-three.txt', 'restore-update-three', artifactId);
    const mutationsBeforeRestore = tracked.mutations;

    const request = {
      method: 'POST' as const,
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/restores`,
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'idempotency-key': 'restore-version-one',
      },
      payload: { sourceRevisionId },
    };
    const restored = await app.inject(request);
    const replayed = await app.inject(request);

    expect(restored.statusCode).toBe(201);
    expect(restored.json()).toMatchObject({
      artifactId,
      revisionNumber: 4,
      sourceRevisionId,
      replayed: false,
      provenance: {
        classification: 'restore',
        observed: { operation: 'revision.restore' },
        source: { revisionId: sourceRevisionId },
      },
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toMatchObject({
      revisionId: restored.json().revisionId,
      revisionNumber: 4,
      replayed: true,
    });
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/revisions`,
      headers: { authorization: 'Bearer test' },
    });
    expect(history.json().items).toMatchObject([
      {
        revisionId: restored.json().revisionId,
        revisionNumber: 4,
        originalFileName: 'version-one.txt',
        provenance: { classification: 'restore', source: { revisionId: sourceRevisionId } },
      },
      { revisionNumber: 3 },
      { revisionNumber: 2 },
      { revisionId: sourceRevisionId, revisionNumber: 1 },
    ]);
    const content = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${restored.json().revisionId}/content`,
      headers: { authorization: 'Bearer test' },
    });
    expect(content.rawPayload.toString()).toBe('version one');
    expect(tracked.mutations).toBe(mutationsBeforeRestore);
  });

  it('does not restore a source revision owned by another artifact', async () => {
    const tracked = await trackedContentFixture();
    const { app } = tracked;
    const target = await publish(app, 'target', 'target.txt', 'restore-target');
    const other = await publish(app, 'other', 'other.txt', 'restore-other');
    const mutationsBeforeRestore = tracked.mutations;
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${target.json().artifactId}/restores`,
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        'idempotency-key': 'cross-artifact-restore',
      },
      payload: { sourceRevisionId: other.json().revisionId },
    });
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${target.json().artifactId}/revisions`,
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'REVISION_NOT_FOUND' } });
    expect(history.json().items).toHaveLength(1);
    expect(tracked.mutations).toBe(mutationsBeforeRestore);
  });

  it('uses revision.read authorization for every catalog surface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-artifact-denied-'));
    roots.push(root);
    const app = await createShelfApp({
      stagingRoot: root,
      authenticator: {
        async authenticate() {
          return { installationId: 'installation-main', actorId: 'actor-denied' };
        },
      },
      authorizer: {
        async authorize() {
          throw new AuthorizationDeniedError();
        },
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/artifacts',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
  });
});
