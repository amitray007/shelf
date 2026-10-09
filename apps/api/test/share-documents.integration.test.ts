import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { type CreateShelfAppOptions, createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: Partial<CreateShelfAppOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-share-documents-'));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>shelf</title></head><body><div id="root"></div></body></html>',
  );
  await writeFile(join(root, 'favicon.svg'), '<svg/>');
  let index = 0;
  const app = await createShelfApp({
    stagingRoot: join(root, 'staging'),
    webRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'install-local', actorId: 'actor-agent' };
      },
    },
    authorizer: { async authorize() {} },
    generatePublicCode: () => `Pub${String(index++).padStart(9, '0')}`,
    ...options,
  });
  apps.push(app);
  return app;
}

function multipart(
  parts: Array<{ name: string; value: string; filename?: string; type?: string }>,
) {
  const boundary = 'shelf-reader-test';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `${parts
      .map(
        (part) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n${part.value}\r\n`,
      )
      .join('')}--${boundary}--\r\n`,
  };
}

async function publish(
  app: FastifyInstance,
  value = '# Report\n\nOriginal source.\n',
  mediaType = 'text/markdown',
  artifactId?: string,
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/main/artifacts${artifactId ? `/${artifactId}/revisions` : ''}`,
    ...multipart([
      {
        name: 'publisherMetadata',
        value: JSON.stringify({ title: 'Report', description: 'Reader fixture' }),
      },
      { name: 'file', filename: 'report.md', type: mediaType, value },
    ]),
    headers: {
      'content-type': 'multipart/form-data; boundary=shelf-reader-test',
      'idempotency-key': `publish-${value}`,
      authorization: 'Bearer fixture',
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

async function share(
  app: FastifyInstance,
  artifactId: string,
  policy: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/main/artifacts/${artifactId}/shares`,
    headers: {
      authorization: 'Bearer fixture',
      'idempotency-key': `share-${artifactId}-${JSON.stringify(policy)}`,
    },
    payload: { accessType: 'public', target: { mode: 'latest' }, ...policy },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json();
}

describe('agent share documents', () => {
  it('advertises read APIs in HTML and HEAD without exposing artifact content', async () => {
    const app = await fixture();
    const published = await publish(app);
    const link = await share(app, published.artifactId);
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({
        method,
        url: link.url,
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers.link).toContain(`/s/${link.publicCode}?format=json`);
      expect(response.headers.link).toContain('/llms.txt');
      expect(response.headers.link).toContain('/api/v1/openapi.json');
      expect(response.headers.vary).toBe('Accept');
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
      if (method === 'GET') {
        expect(response.body).toContain('<noscript>');
        expect(response.body).toContain('rel="alternate"');
        expect(response.body).not.toContain('Original source');
      } else expect(response.body).toBe('');
    }
    const discussion = await app.inject({ url: `${link.url}?thread=cmt_x` });
    expect(discussion.statusCode).toBe(200);
    expect(discussion.headers['content-type']).toContain('text/html');
  });

  it('returns JSON metadata and exact Markdown from the same Public URL', async () => {
    const app = await fixture();
    const published = await publish(app);
    const link = await share(app, published.artifactId);
    const metadata = await app.inject({ url: link.url, headers: { accept: 'application/json' } });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      accessType: 'public',
      revision: { revisionId: published.revisionId },
      action: { type: 'content' },
    });
    expect(metadata.headers.link).toContain(`revisionId=${published.revisionId}`);
    for (const request of [
      { url: link.url, headers: { accept: 'text/markdown' } },
      { url: `${link.url}?format=markdown` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('# Report\n\nOriginal source.\n');
      expect(response.headers['content-type']).toContain('text/markdown');
      expect(response.headers['cache-control']).toBe('no-store, no-transform');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    }
  });

  it('honors preferences, wildcard precedence, exclusions, and explicit formats', async () => {
    const app = await fixture();
    const link = await share(app, (await publish(app)).artifactId);
    for (const [accept, type] of [
      ['*/*', 'text/html'],
      ['text/*', 'text/html'],
      ['text/html;q=0.5, application/json;q=0.9', 'application/json'],
      ['application/json;q=0,*/*;q=1', 'text/html'],
      ['text/html;q=0,text/markdown;q=0.7', 'text/markdown'],
      ['text/html;q=0, text/*', 'text/markdown'],
      ['application/octet-stream;q=0.5, application/json;q=0.5', 'application/json'],
      ['*/*;q=0, text/html', 'text/html'],
    ]) {
      const response = await app.inject({ url: link.url, headers: { accept } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain(type);
    }
    const rejected = await app.inject({ url: link.url, headers: { accept: 'image/png' } });
    expect(rejected.statusCode).toBe(406);
    expect(rejected.json().error).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(rejected.headers.link).toContain('/llms.txt');
    expect(rejected.headers['cache-control']).toBe('no-store, no-transform');
    expect(rejected.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    for (const accept of ['text/markdown;q=0, text/plain', 'text/html;q=0, application/json;q=0']) {
      expect((await app.inject({ url: link.url, headers: { accept } })).statusCode).toBe(406);
    }
    const explicit = await app.inject({
      url: `${link.url}?format=json`,
      headers: { accept: 'text/html' },
    });
    expect(explicit.headers['content-type']).toContain('application/json');
  });

  it('streams original source as an attachment with ranges and validators', async () => {
    const app = await fixture();
    const link = await share(
      app,
      (await publish(app, '<script>unsafe()</script>', 'text/html')).artifactId,
    );
    const source = await app.inject({ url: `${link.url}?format=source` });
    expect(source.body).toBe('<script>unsafe()</script>');
    expect(source.headers['content-disposition']).toMatch(/^attachment;/);
    const range = await app.inject({
      url: link.url,
      headers: { accept: 'application/octet-stream', range: 'bytes=0-7' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('<script>');
    const cached = await app.inject({
      url: `${link.url}?format=source`,
      headers: { 'if-none-match': source.headers.etag as string },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');
    const description = await app.inject({ url: `${link.url}?format=markdown` });
    expect(description.body).toContain('[Download source]');
    expect(description.body).not.toContain('<script>');
  });

  it('lists folder files, follows pagination, and reads one path without rendering', async () => {
    const app = await fixture();
    const dataPath = 'data [set](x)#&.json';
    const body = multipart([
      {
        name: 'publisherMetadata',
        value: JSON.stringify({
          title: 'Folder <script>unsafe()</script> [link](https://example.com)',
        }),
      },
      {
        name: 'manifest',
        value: JSON.stringify({
          version: 'shelf-folder-manifest/v1',
          rootName: 'report',
          entries: [
            { path: dataPath, kind: 'file', mediaType: 'application/json' },
            { path: 'index.html', kind: 'file', mediaType: 'text/html' },
          ],
        }),
      },
      { name: 'file', filename: dataPath, type: 'application/json', value: '{"count":42}' },
      { name: 'file', filename: 'index.html', type: 'text/html', value: '<h1>Report</h1>' },
    ]);
    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/main/folders',
      ...body,
      headers: { ...body.headers, authorization: 'Bearer fixture', 'idempotency-key': 'folder' },
    });
    expect(published.statusCode, published.body).toBe(201);
    const link = await share(app, published.json().artifactId);
    const first = await app.inject({ url: `${link.url}?format=markdown&limit=1` });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).toContain('data \\[set\\]\\(x\\)');
    expect(first.body).not.toContain('<script>');
    expect(first.body).not.toContain('[link](https://example.com)');
    const dataLink = /\[source\]\(([^)]+)\)/.exec(first.body)?.[1];
    expect(dataLink).toBeTruthy();
    expect(new URL(dataLink as string, 'http://localhost').searchParams.get('path')).toBe(dataPath);
    expect(first.body).not.toContain('index.html');
    const next = /\[Next page\]\(([^)]+)\)/.exec(first.body)?.[1];
    expect(next).toBeTruthy();
    const second = await app.inject({ url: next as string });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.body).toContain('index.html');
    expect(second.body).not.toContain('[Next page]');
    const source = await app.inject({
      url: `${link.url}?format=source&path=${encodeURIComponent(dataPath)}`,
    });
    expect(source.statusCode).toBe(200);
    expect(source.json()).toEqual({ count: 42 });
    const missing = await app.inject({ url: `${link.url}?format=source` });
    expect(missing.statusCode).toBe(400);
    const traversal = await app.inject({ url: `${link.url}?format=source&path=../secret` });
    expect(traversal.statusCode).toBe(400);
  });

  it('rejects foreign revisions and history before the share was created', async () => {
    const app = await fixture();
    const first = await publish(app, '# Before sharing');
    const second = await publish(app, '# Shared revision', 'text/markdown', first.artifactId);
    const history = await share(app, first.artifactId, { revisionAccess: 'shared-history' });
    await publish(app, '# Latest revision', 'text/markdown', first.artifactId);
    const foreign = await publish(app, '# Another artifact');
    for (const format of ['json', 'markdown', 'source']) {
      for (const revisionId of [first.revisionId, foreign.revisionId]) {
        const response = await app.inject({
          url: `${history.url}?format=${format}&revision=${revisionId}`,
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().error.code).toBe('SHARE_NOT_FOUND');
      }
      const allowed = await app.inject({
        url: `${history.url}?format=${format}&revision=${second.revisionId}`,
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
    }
  });

  it('keeps Latest, Pinned, and shared-history revision boundaries', async () => {
    const app = await fixture();
    const first = await publish(app, '# First');
    const latest = await share(app, first.artifactId);
    const pinned = await share(app, first.artifactId, {
      target: { mode: 'pinned', revisionId: first.revisionId },
    });
    const history = await share(app, first.artifactId, { revisionAccess: 'shared-history' });
    const second = await publish(app, '# Second', 'text/markdown', first.artifactId);
    expect((await app.inject({ url: `${latest.url}?format=source` })).body).toBe('# Second');
    expect((await app.inject({ url: `${pinned.url}?format=source` })).body).toBe('# First');
    for (const format of ['json', 'markdown', 'source']) {
      expect(
        (await app.inject({ url: `${latest.url}?format=${format}&revision=${first.revisionId}` }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ url: `${pinned.url}?format=${format}&revision=${second.revisionId}` }))
          .statusCode,
      ).toBe(404);
    }
    expect(
      (await app.inject({ url: `${history.url}?format=source&revision=${first.revisionId}` })).body,
    ).toBe('# First');
  });

  it('blocks revoked and expired Public links, including conditional reads', async () => {
    let now = new Date('2026-10-09T12:00:00.000Z');
    const app = await fixture({ shareClock: () => now });
    const published = await publish(app);
    const expired = await share(app, published.artifactId, { expiresIn: '5m' });
    const revoked = await share(app, published.artifactId);
    const original = await app.inject({ url: `${revoked.url}?format=source` });
    const revocation = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/main/shares/${revoked.shareId}`,
      headers: { authorization: 'Bearer fixture' },
    });
    expect(revocation.statusCode, revocation.body).toBe(200);
    now = new Date('2026-10-09T12:06:00.000Z');
    for (const link of [expired, revoked]) {
      for (const format of ['json', 'markdown', 'source']) {
        const response = await app.inject({
          url: `${link.url}?format=${format}`,
          headers: { 'if-none-match': original.headers.etag as string },
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json().error.code).toBe('SHARE_NOT_FOUND');
        expect(response.headers['cache-control']).toBe('no-store, no-transform');
      }
    }
  });

  it('provides Protected session instructions without artifact data or spending a session', async () => {
    const app = await fixture();
    const published = await publish(app);
    const link = await share(app, published.artifactId, {
      accessType: 'protected',
      maxSessions: 1,
    });
    const url = link.url.split('#')[0];
    const instructions = await app.inject({ url: `${url}?format=json` });
    expect(instructions.statusCode).toBe(200);
    expect(instructions.json()).toMatchObject({
      authentication: { path: `/api/v1/public/shares/${link.shareId}/sessions` },
    });
    expect(instructions.body).not.toContain(published.artifactId);
    expect(instructions.body).not.toContain(published.revisionId);
    const markdown = await app.inject({ url: `${url}?format=markdown` });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.body).toContain(`/api/v1/public/shares/${link.shareId}/sessions`);
    expect(markdown.body).toContain('Reuse sessionId across retries');
    expect(markdown.body).not.toContain(published.artifactId);
    expect(markdown.body).not.toContain(published.revisionId);
    expect(markdown.body).not.toContain('Original source');
    expect(markdown.body).not.toContain(link.url.split('#')[1]);
    const unknown = await app.inject({ url: '/s/shr_ZZZZZZZZZZZZZZZZZZZZZZ?format=json' });
    expect(unknown.statusCode).toBe(200);
    const denied = await app.inject({ url: `${url}?format=source` });
    expect(denied.statusCode).toBe(404);
    const exchange = await app.inject({
      method: 'POST',
      url: instructions.json().authentication.path,
      payload: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        secret: link.url.split('#')[1],
      },
    });
    expect(exchange.statusCode, exchange.body).toBe(200);
    const read = await app.inject({
      method: 'POST',
      url: exchange.json().resolution.action.path,
      payload: { token: exchange.json().token, revisionId: published.revisionId },
    });
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe('# Report\n\nOriginal source.\n');
  });

  it('serves a secret-free guide and runtime OpenAPI without workspace authentication', async () => {
    const app = await fixture({
      authenticator: {
        async authenticate() {
          throw new Error('Reader must be anonymous');
        },
      },
    });
    const guide = await app.inject({ url: '/llms.txt' });
    expect(guide.statusCode).toBe(200);
    expect(guide.headers['content-type']).toContain('text/plain');
    expect(guide.body).toContain('Protected links');
    const schema = await app.inject({ url: '/api/v1/openapi.json' });
    expect(schema.statusCode).toBe(200);
    expect(schema.json()).toMatchObject({ openapi: '3.1.0' });
    expect(schema.json().paths['/api/v1/public/shares/{shareId}/sessions']).toBeDefined();
    expect(schema.body).not.toContain('Bearer fixture');
  });
});
