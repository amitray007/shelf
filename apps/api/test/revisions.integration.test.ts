import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthorizationDeniedError,
  type AuthorizationRequest,
  type Authorizer,
  type ContentReader,
  createPublishService,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryRevisionRepository } from '../src/adapters/memory-revision-repository.js';
import { TemporaryContentStore } from '../src/adapters/temporary-content-store.js';
import { type Authenticator, createShelfApp } from '../src/app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const authenticated: Authenticator = {
  async authenticate() {
    return { installationId: 'install-local', actorId: 'actor-reader' };
  },
};

class MutableAuthorizer implements Authorizer {
  denyReads = false;
  readonly observed: AuthorizationRequest[] = [];

  async authorize(request: AuthorizationRequest): Promise<void> {
    this.observed.push(request);
    if (this.denyReads && request.action === 'revision.read') {
      throw new AuthorizationDeniedError();
    }
  }
}

async function fixture(options: { authenticator?: Authenticator } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-revision-test-'));
  roots.push(root);
  const authorizer = new MutableAuthorizer();
  const revisionRepository = new MemoryRevisionRepository();
  const contentStore = new TemporaryContentStore(root);
  let contentReads = 0;
  const contentReader: ContentReader = {
    async read(content, readOptions) {
      contentReads += 1;
      return contentStore.read(content, readOptions);
    },
  };
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: options.authenticator ?? authenticated,
    authorizer,
    contentStore,
    contentReader,
    revisionRepository,
  });
  apps.push(app);

  async function seed(
    value = '0123456789',
    originalFileName = 'numbers.txt',
    mediaType = 'text/plain',
  ) {
    const publish = createPublishService({ authorizer, contentStore, revisionRepository });
    return publish({
      installationId: 'install-local',
      workspaceId: 'workspace-main',
      actorId: 'actor-publisher',
      requestId: 'seed-request',
      idempotencyKey: `seed-${crypto.randomUUID()}`,
      originalFileName,
      mediaType,
      publisherMetadata: {},
      content: (async function* bytes() {
        yield encoder.encode(value);
      })(),
    });
  }

  return {
    app,
    authorizer,
    seed,
    get contentReads() {
      return contentReads;
    },
  };
}

function get(app: FastifyInstance, revisionId: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/revisions/${revisionId}/content`,
    headers: { authorization: 'Bearer test', ...headers },
  });
}

describe('GET /api/v1/revisions/:revisionId/content', () => {
  it('downloads an exact pinned revision with strong validation and safety headers', async () => {
    const context = await fixture();
    const published = await context.seed();
    const response = await get(context.app, published.revisionId);

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.toString()).toBe('0123456789');
    expect(response.headers).toMatchObject({
      'accept-ranges': 'bytes',
      'content-length': '10',
      'content-type': 'text/plain',
      'content-disposition': expect.stringContaining('attachment;'),
      etag: `"${published.contentHash}"`,
      'x-content-type-options': 'nosniff',
    });
    expect(context.authorizer.observed.at(-1)).toMatchObject({
      workspaceId: 'workspace-main',
      actorId: 'actor-reader',
      action: 'revision.read',
    });
    expect(context.contentReads).toBe(1);
  });

  it.each([
    ['first', 'bytes=0-2', '012', 'bytes 0-2/10'],
    ['middle', 'bytes=3-5', '345', 'bytes 3-5/10'],
    ['suffix', 'bytes=-3', '789', 'bytes 7-9/10'],
    ['open-ended', 'bytes=7-', '789', 'bytes 7-9/10'],
  ])('serves a valid %s single range', async (_kind, range, body, contentRange) => {
    const context = await fixture();
    const published = await context.seed();
    const response = await get(context.app, published.revisionId, { range });

    expect(response.statusCode).toBe(206);
    expect(response.rawPayload.toString()).toBe(body);
    expect(response.headers['content-range']).toBe(contentRange);
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  it.each(['bytes=invalid', 'bytes=5-3', 'bytes=10-', 'bytes=-0'])(
    'rejects invalid or unsatisfiable range %s without revision bytes',
    async (range) => {
      const context = await fixture();
      const published = await context.seed();
      const response = await get(context.app, published.revisionId, { range });

      expect(response.statusCode).toBe(416);
      expect(response.headers['content-range']).toBe('bytes */10');
      expect(response.json()).toMatchObject({
        error: { code: 'RANGE_NOT_SATISFIABLE', retryable: false },
      });
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(context.contentReads).toBe(0);
    },
  );

  it('rejects unsupported multi-range delivery explicitly', async () => {
    const context = await fixture();
    const published = await context.seed();
    const response = await get(context.app, published.revisionId, {
      range: 'bytes=0-1,4-5',
    });

    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */10');
    expect(response.json()).toMatchObject({
      error: { code: 'MULTI_RANGE_UNSUPPORTED', retryable: false },
    });
    expect(context.contentReads).toBe(0);
  });

  it('returns no body and opens no content for a matching conditional entity tag', async () => {
    const context = await fixture();
    const published = await context.seed();
    const response = await get(context.app, published.revisionId, {
      'if-none-match': `W/"unrelated", W/"${published.contentHash}"`,
    });

    expect(response.statusCode).toBe(304);
    expect(response.rawPayload).toHaveLength(0);
    expect(response.headers.etag).toBe(`"${published.contentHash}"`);
    expect(context.contentReads).toBe(0);
  });

  it('authenticates and authorizes before opening content', async () => {
    const context = await fixture();
    const published = await context.seed();
    context.authorizer.denyReads = true;
    const denied = await get(context.app, published.revisionId);

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
    expect(denied.rawPayload.toString()).not.toContain('0123456789');
    expect(context.contentReads).toBe(0);

    const unauthenticated = await fixture({ authenticator: { async authenticate() {} } });
    const otherPublished = await unauthenticated.seed();
    const missing = await get(unauthenticated.app, otherPublished.revisionId);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    expect(missing.rawPayload.toString()).not.toContain('0123456789');
    expect(unauthenticated.contentReads).toBe(0);
  });

  it('forces active HTML to download and prevents filename path or header injection', async () => {
    const context = await fixture();
    const published = await context.seed(
      '<script>alert(1)</script>',
      '../private\\folder/\u0001evil"name.html',
      'text/html',
    );
    const response = await get(context.app, published.revisionId);
    const disposition = response.headers['content-disposition'];

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(disposition).toContain('attachment;');
    expect(disposition).toContain('filename="evil_name.html"');
    expect(disposition).toContain("filename*=UTF-8''evil%22name.html");
    expect(disposition).not.toMatch(/[\r\n\\]/u);
    expect(disposition).not.toContain('private');
  });

  it('returns the canonical not-found error for an unknown valid revision id', async () => {
    const context = await fixture();
    const response = await get(context.app, `rev_${'Z'.repeat(22)}`);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'REVISION_NOT_FOUND' } });
    expect(context.contentReads).toBe(0);
  });
});
