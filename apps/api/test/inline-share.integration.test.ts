import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { TemporaryContentStore } from '../src/adapters/temporary-content-store.js';
import { type CreateShelfAppOptions, createShelfApp } from '../src/app.js';
import { createHmacShareCapabilityCodec } from '../src/share-capability.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function multipart(
  parts: Array<{ name: string; value: string; filename?: string; type?: string }>,
) {
  const boundary = 'shelf-share-test-boundary';
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

async function fixture(overrides: Partial<CreateShelfAppOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-share-api-test-'));
  roots.push(root);
  let shareIdIndex = 0;
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'install-local', actorId: 'actor-agent' };
      },
    },
    authorizer: { async authorize() {} },
    shareCapabilityCodec: createHmacShareCapabilityCodec(Buffer.alloc(32, 7)),
    generateShareId: () => `shr_${String(shareIdIndex++).padStart(22, '0')}`,
    ...overrides,
  });
  apps.push(app);
  return app;
}

async function publishFile(app: FastifyInstance, value: string, key: string, artifactId?: string) {
  const body = multipart([
    { name: 'publisherMetadata', value: '{"privateSource":"agent-run"}' },
    { name: 'file', filename: 'note.txt', type: 'text/plain', value },
  ]);
  const suffix = artifactId === undefined ? 'artifacts' : `artifacts/${artifactId}/revisions`;
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/${suffix}`,
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': key },
    payload: body.payload,
  });
}

async function createShare(
  app: FastifyInstance,
  artifactId: string,
  key: string,
  target: { mode: 'latest' } | { mode: 'pinned'; revisionId: string } = { mode: 'latest' },
  expiresAt: string | null = null,
  accessType: 'protected' | 'public' = 'protected',
  revisionAccess?: 'target-only' | 'shared-history',
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/shares`,
    headers: { authorization: 'Bearer test', 'idempotency-key': key },
    payload: {
      accessType,
      target,
      ...(expiresAt === null ? {} : { expiresAt }),
      ...(revisionAccess === undefined ? {} : { revisionAccess }),
    },
  });
}

function publicHeaders(response: { headers: Record<string, string | string[] | undefined> }) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
}

describe('opt-in inline share content', () => {
  it.each([1, 262144, 262145])('bounds file bytes at %i bytes', async (size) => {
    const app = await fixture();
    const published = await publishFile(app, 'x'.repeat(size), 'inline-file');
    expect(published.statusCode).toBe(201);
    const artifactId = published.json().artifactId as string;
    for (const accessType of ['protected', 'public'] as const) {
      const created = await createShare(
        app,
        artifactId,
        `inline-${accessType}`,
        { mode: 'latest' },
        null,
        accessType,
      );
      expect(created.statusCode).toBe(201);
      const share = created.json();
      const request = (inline: boolean, secret = (share.url as string).split('#')[1]) =>
        accessType === 'protected'
          ? app.inject({
              method: 'POST',
              url: `/api/v1/public/shares/${share.shareId}/sessions`,
              headers: inline ? { 'X-Shelf-Inline-Content': 'true' } : {},
              payload: {
                sessionId: '11111111-1111-4111-8111-111111111111',
                secret,
              },
            })
          : app.inject({
              method: 'GET',
              url: `/api/v1/public/links/${share.publicCode}/resolve`,
              headers: inline ? { 'X-Shelf-Inline-Content': 'true' } : {},
            });
      if (accessType === 'protected') {
        const wrong = 'Z'.repeat(43);
        expect((await request(true, wrong)).statusCode).toBe(404);
        expect((await request(false, wrong)).statusCode).toBe(404);
      }
      const plain = await request(false);
      expect(plain.statusCode).toBe(200);
      expect((plain.json().resolution ?? plain.json()).inlineContent).toBeUndefined();
      const response = await request(true);
      expect(response.statusCode).toBe(200);
      publicHeaders(response);
      const resolved = response.json().resolution ?? response.json();
      if (size <= 262144)
        expect(Buffer.from(resolved.inlineContent.base64, 'base64').toString()).toBe(
          'x'.repeat(size),
        );
      else expect(resolved.inlineContent).toBeUndefined();
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/workspace-main/shares/${share.shareId}`,
        headers: { authorization: 'Bearer test' },
      });
      expect((await request(true)).statusCode).toBe(404);
      expect((await request(false)).statusCode).toBe(404);
    }
  });
});

it('omits inline content instead of failing when the inline read fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shelf-share-inline-failure-'));
  roots.push(root);
  const store = new TemporaryContentStore(root);
  let failReads = false;
  const app = await fixture({
    contentStore: store,
    contentReader: {
      async read(content, options) {
        if (failReads) throw new Error('storage offline');
        return store.read(content, options);
      },
    },
  });
  const published = await publishFile(app, 'hello', 'inline-read-failure');
  expect(published.statusCode).toBe(201);
  const artifactId = published.json().artifactId as string;
  failReads = true;
  for (const accessType of ['protected', 'public'] as const) {
    const created = await createShare(
      app,
      artifactId,
      `inline-failure-${accessType}`,
      { mode: 'latest' },
      null,
      accessType,
    );
    expect(created.statusCode).toBe(201);
    const share = created.json();
    const response =
      accessType === 'protected'
        ? await app.inject({
            method: 'POST',
            url: `/api/v1/public/shares/${share.shareId}/sessions`,
            headers: { 'X-Shelf-Inline-Content': 'true' },
            payload: {
              sessionId: '22222222-2222-4222-8222-222222222222',
              secret: (share.url as string).split('#')[1],
            },
          })
        : await app.inject({
            method: 'GET',
            url: `/api/v1/public/links/${share.publicCode}/resolve`,
            headers: { 'X-Shelf-Inline-Content': 'true' },
          });
    expect(response.statusCode).toBe(200);
    const resolved = response.json().resolution ?? response.json();
    expect(resolved.revision.revisionId).toBe(published.json().revisionId);
    expect(resolved.inlineContent).toBeUndefined();
  }
});

it('inlines the same authorized first folder page for both access types', async () => {
  const app = await fixture();
  const body = multipart([
    { name: 'publisherMetadata', value: '{"privateSource":"agent-run"}' },
    {
      name: 'manifest',
      value: JSON.stringify({
        version: 'shelf-folder-manifest/v1',
        rootName: 'demo',
        entries: [
          ...Array.from({ length: 101 }, (_, index) => ({
            path: `dir-${String(index).padStart(3, '0')}`,
            kind: 'directory',
          })),
          { path: 'src', kind: 'directory' },
          { path: 'src/index.ts', kind: 'file', mediaType: 'text/typescript' },
        ],
      }),
    },
    { name: 'file', filename: 'index.ts', type: 'text/typescript', value: 'export {};' },
  ]);
  const published = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces/workspace-main/folders',
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': 'folder-v1' },
    payload: body.payload,
  });

  for (const accessType of ['protected', 'public'] as const) {
    const created = await createShare(
      app,
      published.json().artifactId,
      `folder-${accessType}`,
      { mode: 'latest' },
      null,
      accessType,
    );
    const share = created.json();
    const response =
      accessType === 'protected'
        ? await app.inject({
            method: 'POST',
            url: `/api/v1/public/shares/${share.shareId}/sessions`,
            headers: { 'X-Shelf-Inline-Content': 'true' },
            payload: {
              sessionId: '11111111-1111-4111-8111-111111111111',
              secret: share.url.split('#')[1],
            },
          })
        : await app.inject({
            method: 'GET',
            url: `/api/v1/public/links/${share.publicCode}/resolve`,
            headers: { 'X-Shelf-Inline-Content': 'true' },
          });
    expect(response.statusCode, response.body).toBe(200);
    publicHeaders(response);
    const resolved = response.json().resolution ?? response.json();
    const separate =
      accessType === 'protected'
        ? await app.inject({
            method: 'POST',
            url: `/api/v1/public/shares/${share.shareId}/tree`,
            payload: { token: response.json().token, revisionId: resolved.revision.revisionId },
          })
        : await app.inject({
            method: 'GET',
            url: `/api/v1/public/links/${share.publicCode}/tree?revisionId=${resolved.revision.revisionId}`,
          });
    expect(separate.statusCode).toBe(200);
    expect(separate.json().items).toHaveLength(100);
    expect(separate.json().nextCursor).not.toBeNull();
    expect(resolved.inlineContent).toEqual({ kind: 'folder', page: separate.json() });
  }
});
