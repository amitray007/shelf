import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { type CreateShelfAppOptions, createShelfApp } from '../src/app.js';
import {
  createHmacShareCapabilityCodec,
  createHmacViewerSessionTokenCodec,
} from '../src/share-capability.js';

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
  accessType: 'protected' | 'public' = 'protected',
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/shares`,
    headers: { authorization: 'Bearer test', 'idempotency-key': key },
    payload: { accessType, target, ...(expiresAt === null ? {} : { expiresAt }) },
  });
}

async function establishSession(
  app: FastifyInstance,
  shareId: string,
  secret: string,
  sessionId = '11111111-1111-4111-8111-111111111111',
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/public/shares/${shareId}/sessions`,
    payload: { sessionId, secret },
  });
}

function publicHeaders(response: { headers: Record<string, string | string[] | undefined> }) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
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
      url: `/api/v1/public/shares/${shareId}/sessions`,
      payload: { sessionId: '11111111-1111-4111-8111-111111111111', secret },
    });
    const deletedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/artifacts/${artifactId}`,
      headers: { authorization: 'Bearer test' },
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
      url: `/api/v1/public/shares/${shareId}/sessions`,
      payload: { sessionId: '11111111-1111-4111-8111-111111111111', secret },
    });

    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({
      apiVersion: 'v1',
      artifactId,
      workspaceId: 'workspace-main',
      revokedShareCount: 3,
    });
    expect(Date.parse(deleted.json().recoverableUntil) - Date.parse(deleted.json().deletedAt)).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
    expect(replayed.json()).toEqual(deleted.json());
    expect(hidden.statusCode).toBe(404);
    expect(hiddenHistory.statusCode).toBe(404);
    expect(rejectedUpdate.statusCode).toBe(404);
    expect(rejectedShare.statusCode, rejectedShare.body).toBe(201);
    expect(publicMiss.statusCode).toBe(404);
    expect(deletedAgain.statusCode, deletedAgain.body).toBe(200);
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ artifact: { artifactId } });
    expect(replayedRecovery.statusCode, replayedRecovery.body).toBe(200);
    expect(replayedRecovery.json()).toMatchObject({
      artifact: { artifactId },
      recoveryShare: { shareId: recovered.json().recoveryShare.shareId, replayed: true },
    });
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

  it('creates, replays, lists, and revokes a reusable management link', async () => {
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
    expect(listed.json().items).toHaveLength(3);
    expect(listed.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: created.json().url })]),
    );
    expect(JSON.stringify(listed.json())).toContain(secret);
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
      url: `/api/v1/public/shares/${created.json().shareId as string}/sessions`,
      payload: { sessionId: '11111111-1111-4111-8111-111111111111', secret },
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
      const established = await establishSession(app, shareId, secret);
      const token = established.json().token as string;
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/resolve`,
        payload: { token },
      });
      const content = await app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/content`,
        payload: { token },
      });
      const formContent = await app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/content`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ token }).toString(),
      });

      expect(established.statusCode, established.body).toBe(200);
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
      expect(formContent.statusCode).toBe(200);
      expect(formContent.body).toBe(expectedBody);
      expect(formContent.headers['content-disposition']).toMatch(/^attachment;/u);
      publicHeaders(resolved);
      publicHeaders(content);
      publicHeaders(formContent);
    }
  });

  it('establishes once, reuses the same session, and keeps its token valid at the limit', async () => {
    const app = await fixture();
    const published = await publishFile(app, 'browser download', 'publish-browser-download');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${published.json().artifactId as string}/shares`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'share-browser-download' },
      payload: { accessType: 'protected', target: { mode: 'latest' }, maxSessions: 1 },
    });
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;

    const unfurl = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/resolve`,
      payload: {},
    });
    const beforeEstablishment = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/shares',
      headers: { authorization: 'Bearer test' },
    });
    const established = await establishSession(app, shareId, secret);
    const reused = await establishSession(app, shareId, secret);
    const blocked = await establishSession(
      app,
      shareId,
      secret,
      '22222222-2222-4222-8222-222222222222',
    );
    const downloaded = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { token: established.json().token },
    });

    expect(unfurl.statusCode).toBe(400);
    expect(
      beforeEstablishment
        .json()
        .items.find((item: { shareId: string }) => item.shareId === shareId),
    ).toMatchObject({ sessionsUsed: 0 });
    expect(established.statusCode, established.body).toBe(200);
    expect(created.json()).toMatchObject({ accessType: 'protected', maxSessions: 1 });
    expect(reused.statusCode, reused.body).toBe(200);
    expect(reused.json()).toMatchObject({
      shareId,
      sessionId: established.json().sessionId,
    });
    expect(blocked.statusCode).toBe(404);
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe('browser download');
    expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/u);
    publicHeaders(downloaded);
  });

  it('renews the same expired authority without consuming another session', async () => {
    let now = new Date('2026-08-18T12:00:00.000Z');
    const app = await fixture({ shareClock: () => now });
    const published = await publishFile(app, 'renewed bytes', 'publish-renewal');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${published.json().artifactId as string}/shares`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'share-renewal' },
      payload: {
        accessType: 'protected',
        target: { mode: 'latest' },
        expiresIn: '3d',
        maxSessions: 1,
      },
    });
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;
    const established = await establishSession(app, shareId, secret);
    const expiredToken = established.json().token as string;
    now = new Date('2026-08-19T12:00:00.000Z');

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { token: expiredToken },
    });
    const renewed = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/sessions`,
      payload: { sessionId: established.json().sessionId, token: expiredToken },
    });
    const downloaded = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { token: renewed.json().token },
    });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/workspace-main/shares',
      headers: { authorization: 'Bearer test' },
    });

    expect(denied.statusCode).toBe(404);
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json().token).not.toBe(expiredToken);
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(
      listed.json().items.find((item: { shareId: string }) => item.shareId === shareId),
    ).toMatchObject({ sessionsUsed: 1, sessionsRemaining: 0 });
  });

  it('collapses tampered, future-issued, and cross-share viewer authority', async () => {
    const now = new Date('2026-08-18T12:00:00.000Z');
    const tokenCodec = createHmacViewerSessionTokenCodec(Buffer.alloc(32, 7));
    const app = await fixture({ shareClock: () => now, viewerSessionTokenCodec: tokenCodec });
    const first = await publishFile(app, 'first private', 'publish-token-first');
    const second = await publishFile(app, 'second private', 'publish-token-second');
    const firstShare = await createShare(app, first.json().artifactId, 'share-token-first');
    const secondShare = await createShare(app, second.json().artifactId, 'share-token-second');
    const shareId = firstShare.json().shareId as string;
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const established = await establishSession(
      app,
      shareId,
      (firstShare.json().url as string).split('#')[1] as string,
      sessionId,
    );
    const token = established.json().token as string;
    const replacement = token.endsWith('x') ? 'y' : 'x';
    const future = tokenCodec.issue({
      shareId,
      sessionId,
      issuedAt: '2026-08-18T12:00:00.001Z',
      accessExpiresAt: '2026-08-18T12:01:00.000Z',
    });
    const requests = [
      app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/resolve`,
        payload: { token: `${token.slice(0, -1)}${replacement}` },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${shareId}/resolve`,
        payload: { token: future },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/public/shares/${secondShare.json().shareId as string}/resolve`,
        payload: { token },
      }),
    ];
    const responses = await Promise.all(requests);
    const malformed = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/resolve`,
      payload: { token: 'malformed' },
    });

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
      publicHeaders(response);
    }
    expect(malformed.statusCode).toBe(400);
    publicHeaders(malformed);
  });

  it('serves a Public share through secret-free link routes with its preset preserved', async () => {
    let now = new Date('2026-08-18T12:00:00.000Z');
    const publicCodes = ['DefaultCode1', 'PubCode_1234'];
    const app = await fixture({
      shareClock: () => now,
      generatePublicCode: () => publicCodes.shift() ?? 'RetryCode123',
    });
    const published = await publishFile(app, 'public bytes', 'publish-public');
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${published.json().artifactId as string}/shares`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'share-public' },
      payload: { accessType: 'public', target: { mode: 'latest' }, expiresIn: '30m' },
    });
    const resolved = await app.inject({
      method: 'GET',
      url: '/api/v1/public/links/PubCode_1234/resolve',
    });
    const content = await app.inject({
      method: 'GET',
      url: '/api/v1/public/links/PubCode_1234/content',
    });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      accessType: 'public',
      publicCode: 'PubCode_1234',
      expiresAt: '2026-08-18T12:30:00.000Z',
      url: '/s/PubCode_1234',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(content.statusCode, content.body).toBe(200);
    expect(content.body).toBe('public bytes');
    publicHeaders(resolved);
    publicHeaders(content);
    now = new Date('2026-08-18T12:30:00.000Z');
    const expired = await app.inject({
      method: 'GET',
      url: '/api/v1/public/links/PubCode_1234/resolve',
    });
    expect(expired.statusCode).toBe(404);
    publicHeaders(expired);
  });

  it('streams protected and public previews with single-range semantics', async () => {
    const app = await fixture();
    const published = await publishFile(app, '0123456789', 'publish-preview');
    const protectedShare = await createShare(
      app,
      published.json().artifactId as string,
      'share-preview-protected',
    );
    const shareId = protectedShare.json().shareId as string;
    const secret = (protectedShare.json().url as string).split('#')[1] as string;
    const established = await establishSession(app, shareId, secret);
    const setCookie = established.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    const viewerToken = established.json().token as string;

    expect(cookie).toMatch(new RegExp(`^shelf_viewer_session_${shareId}=`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=86400');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).toMatch(new RegExp(`^shelf_viewer_session_${shareId}=[A-Za-z0-9._-]+;`));

    const protectedPreview = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { cookie: cookie as string },
    });
    const protectedRange = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { cookie: cookie as string, range: 'bytes=-3' },
    });
    const protectedInvalid = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { cookie: cookie as string, range: 'bytes=0-1,4-5' },
    });
    const protectedUnsatisfiable = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { cookie: cookie as string, range: 'bytes=10-' },
    });
    const protectedMissingCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
    });
    const protectedQueryToken = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview?token=${encodeURIComponent(viewerToken)}`,
    });
    const protectedBodyToken = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${encodeURIComponent(viewerToken)}`,
    });
    const protectedMalformedCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { cookie: `shelf_viewer_session_${shareId}="unterminated` },
    });
    const protectedNotModifiedWithoutCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/content/preview`,
      headers: { 'if-none-match': protectedPreview.headers.etag as string },
    });

    expect(protectedPreview.statusCode).toBe(200);
    expect(protectedPreview.body).toBe('0123456789');
    expect(protectedPreview.headers).toMatchObject({
      'content-type': 'text/html',
      'content-disposition': expect.stringMatching(/^inline;/u),
      'accept-ranges': 'bytes',
      'content-length': '10',
      'content-security-policy': 'sandbox',
    });
    expect(protectedRange.statusCode).toBe(206);
    expect(protectedRange.body).toBe('789');
    expect(protectedRange.headers).toMatchObject({
      'content-range': 'bytes 7-9/10',
      'content-length': '3',
    });
    expect(protectedInvalid.statusCode).toBe(416);
    expect(protectedInvalid.headers['content-range']).toBe('bytes */10');
    expect(protectedInvalid.json()).toMatchObject({
      error: { code: 'MULTI_RANGE_UNSUPPORTED', retryable: false },
    });
    expect(protectedUnsatisfiable.statusCode).toBe(416);
    expect(protectedUnsatisfiable.headers['content-range']).toBe('bytes */10');
    expect(protectedUnsatisfiable.json()).toMatchObject({
      error: { code: 'RANGE_NOT_SATISFIABLE', retryable: false },
    });
    expect(protectedMissingCookie.statusCode).toBe(404);
    for (const response of [
      protectedQueryToken,
      protectedBodyToken,
      protectedMalformedCookie,
      protectedNotModifiedWithoutCookie,
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
      publicHeaders(response);
    }
    publicHeaders(protectedPreview);
    publicHeaders(protectedRange);
    publicHeaders(protectedInvalid);
    publicHeaders(protectedUnsatisfiable);
    publicHeaders(protectedMissingCookie);

    const publicShare = await createShare(
      app,
      published.json().artifactId as string,
      'share-preview-public',
      { mode: 'latest' },
      null,
      'public',
    );
    const publicPreview = await app.inject({
      method: 'GET',
      url: `/api/v1/public/links/${publicShare.json().publicCode as string}/content/preview`,
      headers: { cookie: cookie as string, range: 'bytes=2-5' },
    });
    const publicNotModified = await app.inject({
      method: 'GET',
      url: `/api/v1/public/links/${publicShare.json().publicCode as string}/content/preview`,
      headers: { 'if-none-match': publicPreview.headers.etag as string },
    });

    expect(publicPreview.statusCode).toBe(206);
    expect(publicPreview.body).toBe('2345');
    expect(publicPreview.headers).toMatchObject({
      'content-range': 'bytes 2-5/10',
      'content-disposition': expect.stringMatching(/^inline;/u),
      'content-type': 'text/html',
    });
    expect(publicNotModified.statusCode).toBe(304);
    expect(publicNotModified.rawPayload).toHaveLength(0);
    publicHeaders(publicPreview);
    publicHeaders(publicNotModified);
  });

  it('does not extend a viewer cookie past a near-term share expiry', async () => {
    const now = new Date('2026-08-18T12:00:00.900Z');
    const app = await fixture({ shareClock: () => now });
    const published = await publishFile(app, 'expiring preview', 'publish-preview-expiry');
    const expiresAt = '2026-08-18T12:00:01.050Z';
    const created = await createShare(
      app,
      published.json().artifactId as string,
      'share-preview-expiry',
      { mode: 'latest' },
      expiresAt,
    );
    const shareId = created.json().shareId as string;
    const secret = (created.json().url as string).split('#')[1] as string;
    const established = await establishSession(app, shareId, secret);

    expect(established.statusCode, established.body).toBe(200);
    expect(established.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('keeps Protected capability and viewer-token values out of production request logs', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const sentinelCapability = `${'C'.repeat(42)}_`;
    const app = await fixture({
      logger: { level: 'info', stream },
      shareCapabilityCodec: {
        deriveSecret: () => sentinelCapability,
        validateSecret: (_shareId, secret) => secret === sentinelCapability,
      },
      generatePublicCode: () => 'LoggedPub123',
    });
    const published = await publishFile(app, 'logged bytes', 'publish-logged');
    const protectedShare = await createShare(app, published.json().artifactId, 'share-logged');
    const established = await establishSession(
      app,
      protectedShare.json().shareId,
      sentinelCapability,
    );
    const viewerToken = established.json().token as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedShare.json().shareId as string}/resolve`,
      payload: { token: viewerToken },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${published.json().artifactId as string}/shares`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'share-public-logged' },
      payload: { accessType: 'public', target: { mode: 'latest' } },
    });
    await app.inject({ method: 'GET', url: '/api/v1/public/links/LoggedPub123/resolve' });
    await new Promise<void>((resolve) => stream.write('', resolve));
    const logs = chunks.join('');

    expect(logs).toContain('LoggedPub123');
    expect(logs).not.toContain(sentinelCapability);
    expect(logs).not.toContain(viewerToken);
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
    const established = await establishSession(app, shareId, secret);

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/sessions`,
      payload: { sessionId: '22222222-2222-4222-8222-222222222222', secret: canary },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/public/shares/shr_ZZZZZZZZZZZZZZZZZZZZZZ/sessions',
      payload: { sessionId: '22222222-2222-4222-8222-222222222222', secret },
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/public/shares/not-a-share/resolve',
      payload: { token: established.json().token },
    });
    now = new Date('2026-08-17T12:01:00.000Z');
    const expired = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { token: established.json().token },
    });

    for (const response of [wrong, missing, expired]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain(canary);
      publicHeaders(response);
    }
    expect(malformed.statusCode).toBe(400);
    publicHeaders(malformed);
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
    const established = await establishSession(app, shareId, secret);
    const token = established.json().token as string;
    const setCookie = established.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] as string;

    const tree = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/tree?limit=1`,
      payload: { token },
    });
    const treeFile = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/tree/content?path=${encodeURIComponent('src/index.ts')}`,
      payload: { token },
    });
    const content = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/content`,
      payload: { token },
    });
    const protectedPreview = await app.inject({
      method: 'GET',
      url: `/api/v1/public/shares/${shareId}/tree/content/preview?path=${encodeURIComponent('src/index.ts')}`,
      headers: { cookie, range: 'bytes=0-5' },
    });
    const publicShare = await createShare(
      app,
      published.json().artifactId as string,
      'share-folder-public',
      { mode: 'latest' },
      null,
      'public',
    );
    const publicPreview = await app.inject({
      method: 'GET',
      url: `/api/v1/public/links/${publicShare.json().publicCode as string}/tree/content/preview?path=${encodeURIComponent('src/index.ts')}`,
      headers: { range: 'bytes=-3' },
    });

    expect(tree.statusCode).toBe(200);
    expect(tree.json().items).toHaveLength(1);
    expect(tree.json().nextCursor).toBeTruthy();
    expect(JSON.stringify(tree.json())).not.toMatch(
      /workspace|installation|actor|publisher|provenance|provider|contentId|storage/i,
    );
    expect(content.statusCode).toBe(404);
    expect(content.json()).toMatchObject({ error: { code: 'SHARE_NOT_FOUND' } });
    expect(protectedPreview.statusCode).toBe(206);
    expect(protectedPreview.rawPayload.toString()).toBe('export');
    expect(protectedPreview.headers).toMatchObject({
      'content-range': 'bytes 0-5/10',
      'content-disposition': expect.stringMatching(/^inline;/u),
    });
    expect(publicPreview.statusCode).toBe(206);
    expect(publicPreview.rawPayload.toString()).toBe('{};');
    expect(publicPreview.headers['content-range']).toBe('bytes 7-9/10');
    publicHeaders(tree);
    expect(treeFile.statusCode).toBe(200);
    expect(treeFile.rawPayload.toString()).toBe('export {};');
    expect(treeFile.headers['content-disposition']).toMatch(/^attachment;/u);
    publicHeaders(treeFile);
    publicHeaders(protectedPreview);
    publicHeaders(publicPreview);
    publicHeaders(content);
  });
});
