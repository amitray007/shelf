import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationDeniedError, type Authorizer } from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryContentStore } from '../src/adapters/temporary-content-store.js';
import { type Authenticator, type CreateShelfAppOptions, createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function multipart(
  parts: Array<{ name: string; value: string; filename?: string; type?: string }>,
) {
  const boundary = 'shelf-test-boundary';
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    chunks.push(
      `Content-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n`,
    );
    if (part.type !== undefined) chunks.push(`Content-Type: ${part.type}\r\n`);
    chunks.push('\r\n', part.value, '\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: chunks.join(''),
  };
}

const authenticated: Authenticator = {
  async authenticate() {
    return { installationId: 'install-local', actorId: 'actor-agent' };
  },
};

async function fixture(overrides: Partial<CreateShelfAppOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-api-test-'));
  roots.push(root);
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: authenticated,
    authorizer: { async authorize() {} },
    ...overrides,
  });
  apps.push(app);
  return { app, root };
}

function validBody(file = 'hello shelf', filename = 'README.md') {
  return multipart([
    { name: 'publisherMetadata', value: '{"source":"test","title":"Shelf"}' },
    { name: 'file', filename, type: 'text/markdown', value: file },
  ]);
}

async function publish(app: FastifyInstance, body = validBody(), key = 'publish-readme') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/workspaces/workspace-main/artifacts',
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': key },
    payload: body.payload,
  });
}

async function publishRevision(
  app: FastifyInstance,
  artifactId: string,
  body = validBody('version two', 'CHANGELOG.md'),
  key = 'revise-readme',
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/revisions`,
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': key },
    payload: body.payload,
  });
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await assertion())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for observable state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /api/v1/workspaces/:workspaceId/artifacts', () => {
  it('publishes another revision to the same stable artifact', async () => {
    const { app } = await fixture();
    const first = await publish(app, validBody('version one'), 'create-versioned-artifact');
    const second = await publishRevision(app, first.json().artifactId);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({
      artifactId: first.json().artifactId,
      workspaceId: 'workspace-main',
      replayed: false,
    });
    expect(second.json().revisionId).not.toBe(first.json().revisionId);
  });

  it('rejects an unknown revision target before staging bytes', async () => {
    const { app, root } = await fixture();
    const response = await publishRevision(app, 'art_BBBBBBBBBBBBBBBBBBBBBB');

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
    expect(await filesBelow(join(root, 'staging'))).toEqual([]);
    expect(await filesBelow(join(root, 'sealed'))).toEqual([]);
  });

  it('refuses to construct an app without an explicit authenticator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-api-test-'));
    roots.push(root);

    await expect(
      createShelfApp({
        stagingRoot: root,
        authenticator: undefined as unknown as Authenticator,
        authorizer: { async authorize() {} },
      }),
    ).rejects.toThrow('authenticator');
  });

  it('refuses an incomplete custom content-adapter pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-api-test-'));
    roots.push(root);

    await expect(
      createShelfApp({
        authenticator: authenticated,
        authorizer: { async authorize() {} },
        contentStore: new TemporaryContentStore(root),
      }),
    ).rejects.toThrow('contentStore and contentReader');
  });

  it('publishes one file and returns the canonical result', async () => {
    const { app } = await fixture();
    const response = await publish(app);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      contentHash: 'sha256:36bf0cb1e16ce25c61a2a17850928330a2b5ecf08b4a9d30cf9f5fad29f8c1a4',
      byteCount: 11,
      provenance: {
        classification: 'direct-publish',
        observed: { actorId: 'actor-agent', operation: 'file.publish' },
      },
      publisherMetadata: { source: 'test', title: 'Shelf' },
      replayed: false,
    });
    expect(response.json().requestId).toBeTruthy();
  });

  it('does not treat a normally completed native fetch upload as a disconnect', async () => {
    const { app } = await fixture();
    const baseUrl = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const body = new FormData();
    body.append('publisherMetadata', '{"source":"native-fetch"}');
    body.append('file', new Blob(['hello shelf'], { type: 'text/plain' }), 'hello.txt');

    const response = await fetch(new URL('/api/v1/workspaces/workspace-main/artifacts', baseUrl), {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'idempotency-key': 'native-fetch' },
      body,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ replayed: false, byteCount: 11 });
  });

  it('replays an identical request and conflicts when semantic input changes', async () => {
    const { app } = await fixture();
    const first = await publish(app);
    const replay = await publish(app);
    const conflict = await publish(app, validBody('changed bytes'));

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({
      artifactId: first.json().artifactId,
      revisionId: first.json().revisionId,
      replayed: true,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
    });
  });

  it('linearizes concurrent retries into one revision', async () => {
    const { app } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => publish(app, validBody(), 'concurrent-key')),
    );
    const results = responses.map((response) => response.json());

    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(new Set(results.map((result) => result.revisionId))).toHaveLength(1);
    expect(results.filter((result) => result.replayed === false)).toHaveLength(1);
  });

  it.each([
    ['empty file', validBody('')],
    [
      'duplicate file',
      multipart([
        { name: 'file', filename: 'one.txt', type: 'text/plain', value: 'one' },
        { name: 'file', filename: 'two.txt', type: 'text/plain', value: 'two' },
      ]),
    ],
    [
      'unexpected field',
      multipart([
        { name: 'unexpected', value: 'nope' },
        { name: 'file', filename: 'one.txt', type: 'text/plain', value: 'one' },
      ]),
    ],
    [
      'late metadata field',
      multipart([
        { name: 'file', filename: 'one.txt', type: 'text/plain', value: 'one' },
        { name: 'publisherMetadata', value: '{}' },
      ]),
    ],
  ])('rejects %s and cleans partial staging', async (_label, body) => {
    const { app, root } = await fixture();
    const response = await publish(app, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(await filesBelow(join(root, 'staging'))).toEqual([]);
    expect(await filesBelow(join(root, 'sealed'))).toEqual([]);
  });

  it('rejects over-limit and malformed multipart without leaving staged content', async () => {
    const { app, root } = await fixture({ multipartLimits: { fileSize: 4 } });
    const oversized = await publish(app, validBody('12345'));
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/artifacts',
      headers: {
        'content-type': 'multipart/form-data; boundary=broken',
        authorization: 'Bearer test',
        'idempotency-key': 'malformed',
      },
      payload:
        '--broken\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\npartial',
    });

    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(await filesBelow(join(root, 'staging'))).toEqual([]);
    expect(await filesBelow(join(root, 'sealed'))).toEqual([]);
  });

  it('denies missing authentication and cross-workspace authorization before staging bytes', async () => {
    const unauthenticated = await fixture({ authenticator: { async authenticate() {} } });
    const unauthenticatedResponse = await publish(unauthenticated.app);
    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticatedResponse.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED', retryable: false },
    });
    expect(await filesBelow(unauthenticated.root)).toEqual([]);

    const deniedAuthorizer: Authorizer = {
      async authorize() {
        throw new AuthorizationDeniedError();
      },
    };
    const denied = await fixture({ authorizer: deniedAuthorizer });
    const deniedResponse = await publish(denied.app);
    expect(deniedResponse.statusCode).toBe(403);
    expect(deniedResponse.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
    expect(await filesBelow(denied.root)).toEqual([]);
  });

  it('treats a traversal-shaped filename only as metadata', async () => {
    const { app, root } = await fixture();
    const escaped = join(root, '..', 'shelf-api-escaped.txt');
    await rm(escaped, { force: true });

    const response = await publish(app, validBody('safe bytes', '../../shelf-api-escaped.txt'));

    expect(response.statusCode).toBe(201);
    await expect(access(escaped)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await filesBelow(join(root, 'staging'))).toEqual([]);
    expect(await filesBelow(join(root, 'sealed'))).toHaveLength(1);
  });

  it('aborts and cleans staging when a real chunked upload disconnects', async () => {
    const { app, root } = await fixture({ multipartLimits: { fileSize: 1024 * 1024 } });
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    const body = [
      '--disconnect\r\n',
      'Content-Disposition: form-data; name="file"; filename="partial.txt"\r\n',
      'Content-Type: text/plain\r\n\r\n',
      'x'.repeat(64 * 1024),
    ].join('');
    socket.write(
      [
        'POST /api/v1/workspaces/workspace-main/artifacts HTTP/1.1',
        `Host: ${address.host}`,
        'Authorization: Bearer test',
        'Idempotency-Key: disconnect-key',
        'Content-Type: multipart/form-data; boundary=disconnect',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`,
      ].join('\r\n'),
    );

    await waitFor(async () => (await filesBelow(join(root, 'staging'))).length === 1);
    socket.destroy();
    await waitFor(async () => (await filesBelow(join(root, 'staging'))).length === 0);
    expect(await filesBelow(join(root, 'sealed'))).toEqual([]);

    const retry = await publish(app, validBody(), 'disconnect-key');
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toMatchObject({ replayed: false });
  });
});
