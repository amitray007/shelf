import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';
import { createHmacShareCapabilityCodec } from '../src/share-capability.js';

const apps: FastifyInstance[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function multipart(value: string) {
  const boundary = 'shelf-comments-test-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: [
      `--${boundary}\r\nContent-Disposition: form-data; name="publisherMetadata"\r\n\r\n{}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.md"\r\nContent-Type: text/markdown\r\n\r\n${value}\r\n`,
      `--${boundary}--\r\n`,
    ].join(''),
  };
}

async function fixture(
  authenticationMethod: 'human-session' | 'access-credential' = 'human-session',
) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-comments-api-test-'));
  roots.push(root);
  let shareIndex = 0;
  let publicIndex = 0;
  const app = await createShelfApp({
    stagingRoot: root,
    authenticator: {
      async authenticate() {
        return { installationId: 'install-main', actorId: 'actor-main', authenticationMethod };
      },
    },
    authorizer: { async authorize() {} },
    shareCapabilityCodec: createHmacShareCapabilityCodec(Buffer.alloc(32, 9)),
    generateShareId: () => `shr_${String(shareIndex++).padStart(22, '0')}`,
    generatePublicCode: () => `pub${String(publicIndex++).padStart(9, '0')}`,
    privacyKey: Buffer.alloc(32, 8),
  });
  apps.push(app);
  return app;
}

async function publish(app: FastifyInstance, key = 'comment-publish') {
  const body = multipart('# notes\n\nhello');
  return app.inject({
    method: 'POST',
    url: '/api/v1/workspaces/workspace-main/artifacts',
    headers: {
      ...body.headers,
      authorization: 'Bearer test',
      'idempotency-key': key,
    },
    payload: body.payload,
  });
}

async function publishRevision(
  app: FastifyInstance,
  artifactId: string,
  value: string,
  key: string,
) {
  const body = multipart(value);
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/revisions`,
    headers: { ...body.headers, authorization: 'Bearer test', 'idempotency-key': key },
    payload: body.payload,
  });
}

async function createShare(
  app: FastifyInstance,
  artifactId: string,
  accessType: 'protected' | 'public',
  key: string,
  target: { mode: 'latest' } | { mode: 'pinned'; revisionId: string } = { mode: 'latest' },
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/shares`,
    headers: { authorization: 'Bearer test', 'idempotency-key': key },
    payload: { accessType, target, commentPolicy: 'shared' },
  });
}

const visitorToken = 'v'.repeat(64);

function expectAnonymousHeaders(response: {
  headers: Record<string, string | string[] | undefined>;
}) {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
}

describe('comment HTTP boundary', () => {
  it('reserves administrator edit and delete for human sessions', async () => {
    const app = await fixture('access-credential');
    const artifactId = `art_${'a'.repeat(22)}`;
    const url = `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/post-main`;

    for (const payload of [
      { action: 'edit', body: 'Credential edit.' },
      { action: 'delete' },
    ] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url,
        headers: { authorization: 'Bearer test' },
        payload,
      });
      expect(response.statusCode, response.body).toBe(403);
    }

    const moderation = await app.inject({
      method: 'PATCH',
      url,
      headers: { authorization: 'Bearer test' },
      payload: { moderation: 'hide' },
    });
    expect(moderation.statusCode, moderation.body).toBe(404);
  });

  it('supports protected/public identity reads and authenticated moderation', async () => {
    const app = await fixture();
    const published = await publish(app);
    expect(published.statusCode, published.body).toBe(201);
    const artifactId = published.json().artifactId as string;
    const revisionId = published.json().revisionId as string;
    const protectedShare = await createShare(app, artifactId, 'protected', 'comment-protected');
    const publicShare = await createShare(app, artifactId, 'public', 'comment-public');
    expect(protectedShare.statusCode, protectedShare.body).toBe(201);
    expect(publicShare.statusCode, publicShare.body).toBe(201);
    const shareId = protectedShare.json().shareId as string;
    const secret = (protectedShare.json().url as string).split('#')[1] as string;
    const session = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/sessions`,
      payload: { sessionId: '11111111-1111-4111-8111-111111111111', secret },
    });
    expect(session.statusCode, session.body).toBe(200);
    const token = session.json().token as string;
    const anchor = { revisionId, kind: 'file' };

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/comments/threads`,
      payload: { token, visitorToken, displayName: 'Ada', revisionId, anchor, body: 'Keep this.' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const historyWithoutName = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/comments/query`,
      payload: { token, visitorToken },
    });
    expect(historyWithoutName.statusCode, historyWithoutName.body).toBe(200);
    expect(historyWithoutName.json().items).toHaveLength(1);
    expectAnonymousHeaders(historyWithoutName);

    const publicCode = publicShare.json().publicCode as string;
    const publicCreated = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/threads`,
      payload: { visitorToken, displayName: 'Ada', revisionId, anchor, body: 'Public note.' },
    });
    expect(publicCreated.statusCode, publicCreated.body).toBe(201);
    const publicHistory = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { visitorToken },
    });
    expect(publicHistory.statusCode, publicHistory.body).toBe(200);
    expect(publicHistory.json().items).toHaveLength(1);
    expectAnonymousHeaders(publicHistory);

    const adminHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments`,
      headers: { authorization: 'Bearer test' },
    });
    expect(adminHistory.statusCode, adminHistory.body).toBe(200);
    expect(adminHistory.json().items).toHaveLength(2);

    const summaries = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/comments/summaries',
      headers: { authorization: 'Bearer test' },
      payload: { artifactIds: [artifactId] },
    });
    expect(summaries.statusCode, summaries.body).toBe(200);
    const participant = summaries.json().items[0]?.participants[0];
    expect(participant?.recentThreads).toHaveLength(2);
    expect(participant?.recentThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: created.json().threadId }),
        expect.objectContaining({ threadId: publicCreated.json().threadId }),
      ]),
    );

    const hidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/${publicCreated.json().posts[0].postId}`,
      headers: { authorization: 'Bearer test' },
      payload: { moderation: 'hide' },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    const policy = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/shares/${shareId}/comment-policy`,
      headers: { authorization: 'Bearer test' },
      payload: { commentPolicy: 'off' },
    });
    expect(policy.statusCode, policy.body).toBe(200);
    const stillReadable = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/comments/query`,
      payload: { token, visitorToken },
    });
    expect(stillReadable.statusCode, stillReadable.body).toBe(200);
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${shareId}/comments/threads`,
      payload: { token, visitorToken, displayName: 'Ada', revisionId, anchor, body: 'blocked' },
    });
    expect(blocked.statusCode).toBe(400);
    expectAnonymousHeaders(blocked);
    const malformedPublic = await app.inject({
      method: 'POST',
      url: '/api/v1/public/links/not-a-code/comments/query',
      payload: {},
    });
    expect(malformedPublic.statusCode).toBe(400);
    expectAnonymousHeaders(malformedPublic);
  });

  it('anchors anonymous comments to the revision rendered by a pinned link', async () => {
    const app = await fixture();
    const published = await publish(app);
    const artifactId = published.json().artifactId as string;
    const firstRevisionId = published.json().revisionId as string;
    const second = await publishRevision(app, artifactId, '# second revision', 'comment-publish-2');
    expect(second.statusCode, second.body).toBe(201);
    const secondRevisionId = second.json().revisionId as string;
    const protectedShare = await createShare(
      app,
      artifactId,
      'protected',
      'comment-pinned-protected',
      { mode: 'pinned', revisionId: firstRevisionId },
    );
    const publicShare = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/shares`,
      headers: { authorization: 'Bearer test', 'idempotency-key': 'comment-pinned-public' },
      payload: {
        accessType: 'public',
        target: { mode: 'pinned', revisionId: firstRevisionId },
        commentPolicy: 'shared',
      },
    });
    expect(protectedShare.statusCode, protectedShare.body).toBe(201);
    expect(publicShare.statusCode, publicShare.body).toBe(201);
    const protectedId = protectedShare.json().shareId as string;
    const secret = (protectedShare.json().url as string).split('#')[1] as string;
    const session = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/sessions`,
      payload: { sessionId: '22222222-2222-4222-8222-222222222222', secret },
    });
    const token = session.json().token as string;
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/comments/threads`,
      payload: {
        token,
        visitorToken,
        displayName: 'Ada',
        revisionId: secondRevisionId,
        anchor: { revisionId: secondRevisionId, kind: 'file' },
        body: 'wrong pinned revision',
      },
    });
    expect(wrong.statusCode, wrong.body).toBe(400);
    const protectedCreated = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/comments/threads`,
      payload: {
        token,
        visitorToken,
        displayName: 'Ada',
        revisionId: firstRevisionId,
        anchor: { revisionId: firstRevisionId, kind: 'file' },
        body: 'pinned note',
      },
    });
    expect(protectedCreated.statusCode, protectedCreated.body).toBe(201);
    expect(protectedCreated.json().anchorStatus).toBe('exact');
    const publicCode = publicShare.json().publicCode as string;
    const publicCreated = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/threads`,
      payload: {
        visitorToken,
        displayName: 'Ada',
        revisionId: firstRevisionId,
        anchor: { revisionId: firstRevisionId, kind: 'file' },
        body: 'public pinned note',
      },
    });
    expect(publicCreated.statusCode, publicCreated.body).toBe(201);
    const publicHistory = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { visitorToken },
    });
    expect(publicHistory.statusCode, publicHistory.body).toBe(200);
    expect(publicHistory.json().items[0].anchorStatus).toBe('exact');
  });

  it('paginates comment history with scoped cursors', async () => {
    const app = await fixture();
    const published = await publish(app, 'comment-pagination-publish');
    const artifactId = published.json().artifactId as string;
    const revisionId = published.json().revisionId as string;
    const share = await createShare(app, artifactId, 'public', 'comment-pagination-share');
    const publicCode = share.json().publicCode as string;
    for (let index = 0; index < 26; index += 1) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/public/links/${publicCode}/comments/threads`,
        payload: {
          visitorToken: `${String(index).padStart(2, '0')}${visitorToken.slice(2)}`,
          displayName: 'Pager',
          revisionId,
          anchor: { revisionId, kind: 'file' },
          body: `thread ${index}`,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
    }
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { limit: 25 },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(25);
    expect(first.json().nextCursor).toEqual(expect.any(String));
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { limit: 25, cursor: first.json().nextCursor },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0].threadId).not.toBe(first.json().items[0].threadId);
    const otherShare = await createShare(app, artifactId, 'public', 'comment-pagination-other');
    const otherHistory = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${otherShare.json().publicCode}/comments/query`,
      payload: { cursor: first.json().nextCursor },
    });
    expect(otherHistory.statusCode).toBe(400);
    const tampered = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { cursor: `${first.json().nextCursor}tampered` },
    });
    expect(tampered.statusCode).toBe(400);
  });

  it('supports protected and public visitor mutations, denies other visitors, and moderates history', async () => {
    const app = await fixture();
    const published = await publish(app, 'comment-mutations-publish');
    const artifactId = published.json().artifactId as string;
    const revisionId = published.json().revisionId as string;
    const secondArtifact = await publish(app, 'comment-mutations-other-artifact');
    const otherRevisionId = secondArtifact.json().revisionId as string;
    const protectedShare = await createShare(
      app,
      artifactId,
      'protected',
      'comment-mutations-protected',
    );
    const publicShare = await createShare(app, artifactId, 'public', 'comment-mutations-public');
    const protectedId = protectedShare.json().shareId as string;
    const secret = (protectedShare.json().url as string).split('#')[1] as string;
    const session = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/sessions`,
      payload: { sessionId: '33333333-3333-4333-8333-333333333333', secret },
    });
    const token = session.json().token as string;
    const publicCode = publicShare.json().publicCode as string;

    const protectedThread = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/comments/threads`,
      payload: {
        token,
        visitorToken,
        displayName: 'Ada',
        revisionId,
        anchor: { revisionId, kind: 'file' },
        body: 'protected thread',
      },
    });
    expect(protectedThread.statusCode, protectedThread.body).toBe(201);
    const protectedThreadId = protectedThread.json().threadId as string;
    const protectedPostId = protectedThread.json().posts[0].postId as string;
    const protectedReply = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/comments/threads/${protectedThreadId}/replies`,
      payload: { token, visitorToken, displayName: 'Ada', body: 'protected reply' },
    });
    expect(protectedReply.statusCode, protectedReply.body).toBe(201);
    const protectedResolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/shares/${protectedId}/comments/threads/${protectedThreadId}`,
      payload: { token, visitorToken, status: 'resolve' },
    });
    expect(protectedResolved.statusCode, protectedResolved.body).toBe(200);
    const protectedDeniedReply = await app.inject({
      method: 'POST',
      url: `/api/v1/public/shares/${protectedId}/comments/threads/${protectedThreadId}/replies`,
      payload: { token, visitorToken: 'w'.repeat(64), displayName: 'Other', body: 'denied' },
    });
    expect([400, 404]).toContain(protectedDeniedReply.statusCode);
    const protectedDeniedEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/shares/${protectedId}/comments/posts/${protectedPostId}`,
      payload: { token, visitorToken: 'w'.repeat(64), body: 'not mine' },
    });
    expect(protectedDeniedEdit.statusCode).toBe(404);
    const protectedDeniedDelete = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/shares/${protectedId}/comments/posts/${protectedPostId}`,
      payload: { token, visitorToken: 'w'.repeat(64), action: 'delete' },
    });
    expect(protectedDeniedDelete.statusCode).toBe(404);
    const protectedDeniedReopen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/shares/${protectedId}/comments/threads/${protectedThreadId}`,
      payload: { token, visitorToken, status: 'reopen' },
    });
    expect(protectedDeniedReopen.statusCode).toBe(400);

    const publicThread = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/threads`,
      payload: {
        visitorToken,
        displayName: 'Ada',
        revisionId,
        anchor: { revisionId, kind: 'range', startLine: 1, endLine: 1 },
        body: 'public thread',
      },
    });
    expect(publicThread.statusCode, publicThread.body).toBe(201);
    const publicThreadId = publicThread.json().threadId as string;
    const publicPostId = publicThread.json().posts[0].postId as string;
    const publicReply = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/threads/${publicThreadId}/replies`,
      payload: { visitorToken, displayName: 'Ada', body: 'public reply' },
    });
    expect(publicReply.statusCode, publicReply.body).toBe(201);
    const publicEdited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/links/${publicCode}/comments/posts/${publicPostId}`,
      payload: { visitorToken, body: 'public edited' },
    });
    expect(publicEdited.statusCode, publicEdited.body).toBe(200);
    expect(publicEdited.json().author.displayName).toBe('Ada');
    const publicResolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/links/${publicCode}/comments/threads/${publicThreadId}`,
      payload: { visitorToken, status: 'resolve' },
    });
    expect(publicResolved.statusCode, publicResolved.body).toBe(200);
    const publicDeleted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/links/${publicCode}/comments/posts/${publicReply.json().postId}`,
      payload: { visitorToken, action: 'delete' },
    });
    expect(publicDeleted.statusCode, publicDeleted.body).toBe(200);

    const adminReopened = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/threads/${protectedThreadId}`,
      headers: { authorization: 'Bearer test' },
      payload: { status: 'reopen' },
    });
    expect(adminReopened.statusCode, adminReopened.body).toBe(200);
    const hidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/${protectedPostId}`,
      headers: { authorization: 'Bearer test' },
      payload: { moderation: 'hide' },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    const unhidden = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/${protectedPostId}`,
      headers: { authorization: 'Bearer test' },
      payload: { moderation: 'unhide' },
    });
    expect(unhidden.statusCode, unhidden.body).toBe(200);
    const adminEdited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/${protectedPostId}`,
      headers: { authorization: 'Bearer test' },
      payload: { action: 'edit', body: 'Edited by an administrator.' },
    });
    expect(adminEdited.statusCode, adminEdited.body).toBe(200);
    expect(adminEdited.json().body).toBe('Edited by an administrator.');
    const adminDeleted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments/posts/${protectedPostId}`,
      headers: { authorization: 'Bearer test' },
      payload: { action: 'delete' },
    });
    expect(adminDeleted.statusCode, adminDeleted.body).toBe(200);
    expect(adminDeleted.json().deletedAt).not.toBeNull();

    const ignoredAnonymousRevisionOverride = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { visitorToken, currentRevisionId: otherRevisionId },
    });
    expect(ignoredAnonymousRevisionOverride.statusCode).toBe(200);
    expect(ignoredAnonymousRevisionOverride.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ anchorStatus: 'exact' })]),
    );
    const publicRootDeleted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/public/links/${publicCode}/comments/posts/${publicPostId}`,
      payload: { visitorToken, action: 'delete' },
    });
    expect(publicRootDeleted.statusCode, publicRootDeleted.body).toBe(200);
    expect(publicRootDeleted.json().deletedAt).not.toBeNull();
    const publicAfterRootDelete = await app.inject({
      method: 'POST',
      url: `/api/v1/public/links/${publicCode}/comments/query`,
      payload: { visitorToken },
    });
    expect(publicAfterRootDelete.statusCode).toBe(200);
    expect(publicAfterRootDelete.json().items).toEqual([]);
    const mismatchedAdminRevision = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/workspace-main/artifacts/${artifactId}/comments?currentRevisionId=${otherRevisionId}`,
      headers: { authorization: 'Bearer test' },
    });
    expect(mismatchedAdminRevision.statusCode).toBe(404);
  });
});
