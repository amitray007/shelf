import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { type CreateShelfAppOptions, createShelfApp } from '../src/app.js';
import { createHmacShareCapabilityCodec } from '../src/share-capability.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const fixedShareIds = [
  'shr_AAAAAAAAAAAAAAAAAAAAAA',
  'shr_BBBBBBBBBBBBBBBBBBBBBB',
  'shr_CCCCCCCCCCCCCCCCCCCCCC',
  'shr_DDDDDDDDDDDDDDDDDDDDDD',
];

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
    generateShareId: () => fixedShareIds[shareIdIndex++] ?? 'shr_DDDDDDDDDDDDDDDDDDDDDD',
    ...overrides,
  });
  apps.push(app);
  return app;
}

async function publishFile(app: FastifyInstance, value: string, key: string, artifactId?: string) {
  const body = multipart([
    { name: 'publisherMetadata', value: '{"privateSource":"agent-run"}' },
    { name: 'file', filename: 'launch.html', type: 'text/html', value },
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
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/shares`,
    headers: { authorization: 'Bearer test', 'idempotency-key': key },
    payload: { target, expiresAt },
  });
}

function publicHeaders(response: { headers: Record<string, string | string[] | undefined> }) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
}

describe('share HTTP boundary', () => {
  it('keeps an expired recovery deleted and returns the canonical gone error', async () => {
    let now = new Date('2026-08-18T12:00:00.000Z');
    const app = await fixture({ artifactClock: () => now });
    const published = await publishFile(app, 'expires', 'publish-expiring-recovery');
    const artifactId = published.json().artifactId as string;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    now = new Date(deleted.json().recoverableUntil);
    const expired = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/recovery`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-expired' },
    });
    const stillHidden = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });

    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ error: { code: 'ARTIFACT_RECOVERY_EXPIRED' } });
    expect(stillHidden.statusCode).toBe(404);
  });

  it('revokes artifact shares on recoverable deletion and never resurrects them', async () => {
    const app = await fixture();
    const published = await publishFile(app, 'recoverable', 'publish-recoverable');
    const artifactId = published.json().artifactId as string;
    const created = await createShare(app, artifactId, 'share-recoverable');
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    const replayed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    const hiddenHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}/revisions`,
      headers: { authorization: 'Bearer test' },
    });
    const rejectedUpdate = await publishFile(
      app,
      'must not publish',
      'publish-after-delete',
      artifactId,
    );
    const rejectedShare = await createShare(app, artifactId, 'share-after-delete');
    const publicMiss = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/resolve`,
      payload: { secret },
    });
    const [recovered, replayedRecovery] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${artifactId}/recovery`,
        headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-once' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/artifacts/${artifactId}/recovery`,
        headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-once' },
      }),
    ]);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
    });
    const stillRevoked = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/resolve`,
      payload: { secret },
    });

    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({
      apiVersion: 'v1',
      artifactId,
      workspaceId: 'workspace-main',
      revokedShareCount: 1,
    });
    expect(Date.parse(deleted.json().recoverableUntil) - Date.parse(deleted.json().deletedAt)).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
    expect(replayed.json()).toEqual(deleted.json());
    expect(hidden.statusCode).toBe(404);
    expect(hiddenHistory.statusCode).toBe(404);
    expect(rejectedUpdate.statusCode).toBe(404);
    expect(rejectedShare.statusCode).toBe(404);
    expect(publicMiss.statusCode).toBe(404);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ artifactId });
    expect(replayedRecovery.statusCode, replayedRecovery.body).toBe(200);
    expect(replayedRecovery.json()).toEqual(recovered.json());
    expect(visible.statusCode).toBe(200);
    expect(stillRevoked.statusCode).toBe(404);
  });

  it('rejects recovery idempotency reuse for a different artifact', async () => {
    const app = await fixture();
    const first = await publishFile(app, 'first', 'publish-recovery-first');
    const second = await publishFile(app, 'second', 'publish-recovery-second');
    const firstArtifactId = first.json().artifactId as string;
    const secondArtifactId = second.json().artifactId as string;
    for (const artifactId of [firstArtifactId, secondArtifactId]) {
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/v1/artifacts/${artifactId}`,
        headers: { authorization: 'Bearer test' },
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
    }

    const recovered = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${firstArtifactId}/recovery`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-semantic-key' },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${secondArtifactId}/recovery`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-semantic-key' },
    });

    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('does not turn recovery into success for an artifact that was never deleted', async () => {
    const app = await fixture();
    const published = await publishFile(app, 'still active', 'publish-active-recovery');
    const artifactId = published.json().artifactId as string;

    const recovery = await app.inject({
      method: 'POST',
      url: `/api/v1/artifacts/${artifactId}/recovery`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'recover-active' },
    });

    expect(recovery.statusCode).toBe(404);
    expect(recovery.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
  });

  it('creates, replays, lists, and revokes without exposing capability material in management data', async () => {
    const app = await fixture();
    const published = await publishFile(app, '<h1>launch</h1>', 'publish-launch');
    const artifactId = published.json().artifactId as string;

    const created = await createShare(app, artifactId, 'share-launch');
    const replayed = await createShare(app, artifactId, 'share-launch');
    const secret = (created.json().url as string).split('#')[1] as string;
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/shares?limit=20',
      headers: { authorization: 'Bearer test' },
    });
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/workspace-main/shares/${created.json().shareId as string}`,
      headers: { authorization: 'Bearer test' },
    });
    const revokedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/workspace-main/shares/${created.json().shareId as string}`,
      headers: { authorization: 'Bearer test' },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ replayed: false, target: { mode: 'latest' } });
    expect(created.json().url).toMatch(/^\/s\/shr_[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/u);
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json()).toMatchObject({ replayed: true, url: created.json().url });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toContain(secret);
    expect(JSON.stringify(listed.json())).not.toContain('url');
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toBeTruthy();
    expect(revokedAgain.statusCode).toBe(200);
    expect(revokedAgain.json()).toEqual(revoked.json());
    const replayedAfterRevoke = await createShare(app, artifactId, 'share-launch');
    expect(replayedAfterRevoke.statusCode).toBe(201);
    expect(replayedAfterRevoke.json()).toMatchObject({
      replayed: true,
      revokedAt: revoked.json().revokedAt,
      url: created.json().url,
    });

    const publicMiss = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${created.json().shareId as string}/resolve`,
      payload: { secret },
    });
    expect(publicMiss.statusCode).toBe(404);
    expect(publicMiss.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
    publicHeaders(publicMiss);
  });

  it('linearizes concurrent share creation retries into one canonical capability', async () => {
    const app = await fixture();
    const published = await publishFile(app, 'concurrent', 'publish-concurrent');
    const artifactId = published.json().artifactId as string;

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => createShare(app, artifactId, 'share-concurrent')),
    );
    const bodies = responses.map((response) => response.json());

    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(new Set(bodies.map((body) => body.shareId))).toHaveLength(1);
    expect(new Set(bodies.map((body) => body.url))).toHaveLength(1);
    expect(bodies.filter((body) => body.replayed === false)).toHaveLength(1);
  });

  it('resolves latest on every request, keeps pinned exact, and serves file bytes only as attachments', async () => {
    const app = await fixture();
    const first = await publishFile(app, '<h1>version one</h1>', 'publish-v1');
    expect(first.statusCode, first.body).toBe(201);
    const artifactId = first.json().artifactId as string;
    const revisionId = first.json().revisionId as string;
    expect(revisionId).toMatch(/^rev_/u);
    const latestShare = await createShare(app, artifactId, 'share-latest');
    const pinnedShare = await createShare(app, artifactId, 'share-pinned', {
      mode: 'pinned',
      revisionId,
    });
    expect(latestShare.statusCode, latestShare.body).toBe(201);
    expect(pinnedShare.statusCode, pinnedShare.body).toBe(201);
    await publishFile(app, '<script>versionTwo()</script>', 'publish-v2', artifactId);

    for (const [share, expectedRevision, expectedBody] of [
      [latestShare.json(), undefined, '<script>versionTwo()</script>'],
      [pinnedShare.json(), revisionId, '<h1>version one</h1>'],
    ] as const) {
      const secret = (share.url as string).split('#')[1] as string;
      const shareId = share.shareId as string;
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/resolve`,
        payload: { secret },
      });
      const content = await app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/content`,
        payload: { secret },
      });

      expect(resolved.statusCode).toBe(200);
      if (expectedRevision !== undefined) {
        expect(resolved.json().revision.revisionId).toBe(expectedRevision);
      } else {
        expect(resolved.json().revision.revisionId).not.toBe(revisionId);
      }
      expect(content.statusCode).toBe(200);
      expect(content.body).toBe(expectedBody);
      expect(content.headers['content-type']).toContain('application/octet-stream');
      expect(content.headers['content-disposition']).toMatch(/^attachment;/u);
      publicHeaders(resolved);
      publicHeaders(content);
    }
  });

  it('accepts one bounded form capability for browser-initiated attachment downloads', async () => {
    const app = await fixture();
    const published = await publishFile(app, 'browser download', 'publish-browser-download');
    const created = await createShare(
      app,
      published.json().artifactId as string,
      'share-browser-download',
    );
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;

    const downloaded = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ secret }).toString(),
    });
    const polluted = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `secret=${encodeURIComponent(secret)}&secret=${encodeURIComponent(secret)}`,
    });

    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe('browser download');
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/u);
    expect(polluted.statusCode).toBe(400);
    publicHeaders(downloaded);
    publicHeaders(polluted);
  });

  it('collapses wrong, missing, revoked, and expired shares to one public miss without echoing secrets', async () => {
    let now = new Date('2026-08-17T12:00:00.000Z');
    const app = await fixture({ shareClock: () => now });
    const published = await publishFile(app, 'private bytes', 'publish-secret');
    const created = await createShare(
      app,
      published.json().artifactId as string,
      'share-expiring',
      { mode: 'latest' },
      '2026-08-17T12:01:00.000Z',
    );
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;
    const canary = `${'z'.repeat(42)}Y`;

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/resolve`,
      payload: { secret: canary },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/public/shares/shr_ZZZZZZZZZZZZZZZZZZZZZZ/resolve',
      payload: { secret },
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/public/shares/not-a-share/resolve',
      payload: { secret: 'malformed' },
    });
    now = new Date('2026-08-17T12:01:00.000Z');
    const expired = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { secret },
    });

    for (const response of [wrong, missing, malformed, expired]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(canary);
      publicHeaders(response);
    }
  });

  it('returns a bounded, sanitized public folder tree and rejects file content access', async () => {
    const app = await fixture();
    const body = multipart([
      { name: 'publisherMetadata', value: '{"privateSource":"agent-run"}' },
      {
        name: 'manifest',
        value: JSON.stringify({
          version: 'shelf-folder-manifest/v1',
          rootName: 'demo',
          entries: [
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
    const created = await createShare(app, published.json().artifactId as string, 'share-folder');
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;

    const tree = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/tree?limit=1`,
      payload: { secret },
    });
    const content = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { secret },
    });

    expect(tree.statusCode).toBe(200);
    expect(tree.json().items).toHaveLength(1);
    expect(tree.json().nextCursor).toBeTruthy();
    expect(JSON.stringify(tree.json())).not.toMatch(
      /workspace|installation|actor|publisher|provenance|provider|contentId|storage/i,
    );
    expect(content.statusCode).toBe(404);
    expect(content.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
    publicHeaders(tree);
    publicHeaders(content);
  });
});
