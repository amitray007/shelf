import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import axe from 'axe-core';

import {
  artifactPage,
  commentSummaries,
  commentThreads,
  createdCredentialId,
  createdCredentialToken,
  createdShareId,
  credentialPage,
  dashboardSession,
  folderTreePage,
  historyPages,
  htmlResolution,
  htmlShareId,
  markdownResolution,
  markdownShareId,
  rendererOrigin,
  revisionId,
  richPreviewFixtures,
  sharePage,
  shareSecret,
  workspaceId,
} from './fixtures.ts';

const artifactsById = new Map(
  artifactPage.items.map((artifact) => [artifact.artifactId, artifact]),
);
const historiesByArtifactId = new Map(historyPages.map((page) => [page.artifactId, page]));
const deletedArtifacts = new Set();
const purgedArtifacts = new Set();
const createdWorkspaces = new Set();
const filesByRevisionId = new Map(
  historyPages.flatMap((page) =>
    page.items.flatMap((revision) =>
      revision.kind === 'file' ? [[revision.revisionId, revision]] : [],
    ),
  ),
);

const fixtureRoot = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const e2eAssetRoot = resolve(fileURLToPath(new URL('./assets/', import.meta.url)));
const richFixturesByShareId = new Map(
  richPreviewFixtures
    .filter((fixture) => fixture.accessType === 'protected')
    .map((fixture) => [fixture.shareId, fixture]),
);
const richFixturesByPublicCode = new Map(
  richPreviewFixtures
    .filter((fixture) => fixture.accessType === 'public')
    .map((fixture) => [fixture.publicCode, fixture]),
);
const previewRequests = [];
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

const documentHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    `form-action 'self' ${rendererOrigin}`,
    `frame-src ${rendererOrigin}`,
    "frame-ancestors 'none'",
    "img-src 'self' https://api.dicebear.com data: blob:",
    "media-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
const rendererCanaryHits = new Map();
const rendererFrameName = /^shelf-renderer-[0-9a-f-]{36}$/u;
const viewerToken = `${'v'.repeat(24)}.${'t'.repeat(43)}`;
const viewerCookieToken = `${'c'.repeat(96)}.${'d'.repeat(43)}`;

function json(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4_096) throw new Error('Fixture body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function richFixtureBytes(fixture) {
  const raw = await readFile(resolve(e2eAssetRoot, fixture.assetFile));
  return fixture.encoding === 'base64' ? Buffer.from(raw.toString('ascii').trim(), 'base64') : raw;
}

function hasViewerCookie(request, shareId) {
  return (request.headers.cookie ?? '').includes(`shelf_viewer_session_${shareId}=`);
}

function parseRangeHeader(value, total) {
  if (value === undefined) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value);
  if (match === null) return 'invalid';
  const start = Number(match[1]);
  const requestedEnd = match[2] === '' ? total - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start >= total ||
    requestedEnd < start
  ) {
    return 'invalid';
  }
  return { end: Math.min(requestedEnd, total - 1), start };
}

async function sendRichContent(request, response, fixture, options = {}) {
  const bytes = await richFixtureBytes(fixture);
  const etag = `"fixture-${fixture.shareId}"`;
  if (request.headers['if-none-match'] === etag && options.preview === true) {
    response.writeHead(304, { ETag: etag, 'cache-control': 'no-store' });
    response.end();
    return;
  }
  const range = parseRangeHeader(request.headers.range, bytes.length);
  if (range === 'invalid') {
    response.writeHead(416, {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-range': `bytes */${bytes.length}`,
      ETag: etag,
    });
    response.end();
    return;
  }
  const bodyBytes = range === null ? bytes : bytes.subarray(range.start, range.end + 1);
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': `${options.preview === true ? 'inline' : 'attachment'}; filename="${fixture.fileName}"`,
    'content-length': String(bodyBytes.length),
    'content-type': fixture.mediaType,
    ETag: etag,
    ...(range === null
      ? {}
      : { 'content-range': `bytes ${range.start}-${range.end}/${bytes.length}` }),
  };
  response.writeHead(range === null ? 200 : 206, headers);
  response.end(bodyBytes);
}

// Playwright projects share this fixture process, so mutable state is scoped to the per-project
// session cookie. Without it, whichever project runs first would win every create-once flow.
function fixtureSession(request) {
  return (
    /(?:^|;\s*)shelf-browser-state=([^;]+)/u.exec(request.headers.cookie ?? '')?.[1] ?? 'default'
  );
}

function deletedArtifactKey(request, artifactId) {
  return `${fixtureSession(request)}:${artifactId}`;
}

function createdWorkspaceKey(request, requestedWorkspaceId) {
  return `${fixtureSession(request)}:${requestedWorkspaceId}`;
}

async function api(request, response, url) {
  const path = url.pathname;
  if (path === '/api/v1/dashboard/session') {
    if ((request.headers.cookie ?? '').includes('shelf-browser-anonymous=1')) {
      response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain' });
      response.end('Authentication required.');
      return;
    }
    json(response, 200, {
      ...dashboardSession,
      workspaces: [
        ...dashboardSession.workspaces,
        ...[...createdWorkspaces]
          .filter((key) => key.startsWith(`${fixtureSession(request)}:`))
          .map((key) => ({
            workspaceId: key.slice(key.indexOf(':') + 1),
            actions: ['file.publish', 'revision.read'],
          })),
      ],
    });
    return;
  }
  if (request.method === 'POST' && path === '/api/v1/workspaces') {
    const value = JSON.parse(await body(request));
    if (
      typeof value.workspaceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.workspaceId)
    ) {
      json(response, 400, {
        apiVersion: 'v1',
        error: { code: 'INVALID_REQUEST', message: 'The workspace ID is invalid.' },
      });
      return;
    }
    if (
      value.workspaceId === workspaceId ||
      createdWorkspaces.has(createdWorkspaceKey(request, value.workspaceId))
    ) {
      json(response, 409, {
        apiVersion: 'v1',
        error: {
          code: 'WORKSPACE_ALREADY_EXISTS',
          message: 'A workspace with this ID already exists.',
        },
      });
      return;
    }
    createdWorkspaces.add(createdWorkspaceKey(request, value.workspaceId));
    json(response, 201, {
      apiVersion: 'v1',
      workspaceId: value.workspaceId,
      actions: ['file.publish', 'revision.read'],
    });
    return;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/artifacts`) {
    const sort = url.searchParams.get('sort') === 'created' ? 'createdAt' : 'updatedAt';
    const direction = url.searchParams.get('order') === 'asc' ? 1 : -1;
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const cursor = url.searchParams.get('cursor');
    const offset = cursor?.startsWith('fixture-') ? Number(cursor.slice('fixture-'.length)) : 0;
    const availableArtifacts = artifactPage.items
      .filter(
        (artifact) =>
          !deletedArtifacts.has(deletedArtifactKey(request, artifact.artifactId)) &&
          !purgedArtifacts.has(deletedArtifactKey(request, artifact.artifactId)),
      )
      .toSorted((left, right) => {
        const timestamp = left[sort].localeCompare(right[sort]) * direction;
        return timestamp === 0 ? left.artifactId.localeCompare(right.artifactId) : timestamp;
      });
    const items = availableArtifacts.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    json(response, 200, {
      ...artifactPage,
      items,
      nextCursor: nextOffset < availableArtifacts.length ? `fixture-${nextOffset}` : null,
    });
    return;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/trash`) {
    if (request.method === 'DELETE') {
      const value = JSON.parse(await body(request));
      if (value.confirmWorkspaceId !== workspaceId) {
        json(response, 400, {
          error: { code: 'INVALID_REQUEST', message: 'Invalid confirmation.' },
        });
        return;
      }
      const prefix = `${fixtureSession(request)}:`;
      const keys = [...deletedArtifacts].filter((key) => key.startsWith(prefix));
      for (const key of keys) {
        deletedArtifacts.delete(key);
        purgedArtifacts.add(key);
      }
      json(response, 200, {
        apiVersion: 'v1',
        workspaceId,
        purgedArtifactCount: keys.length,
      });
      return;
    }
    const search = url.searchParams.get('search')?.toLowerCase();
    const items = artifactPage.items
      .filter((artifact) => deletedArtifacts.has(deletedArtifactKey(request, artifact.artifactId)))
      .filter((artifact) => !purgedArtifacts.has(deletedArtifactKey(request, artifact.artifactId)))
      .filter(
        (artifact) =>
          search === undefined ||
          [
            artifact.artifactId,
            artifact.name,
            artifact.latestRevision.kind === 'file'
              ? artifact.latestRevision.originalFileName
              : artifact.latestRevision.rootName,
          ].some((value) => value.toLowerCase().includes(search)),
      )
      .map((artifact) => ({
        apiVersion: 'v1',
        artifact,
        deletedAt: '2026-08-18T12:00:00.000Z',
        purgeAt: '2026-09-17T12:00:00.000Z',
        reason: 'manual',
      }));
    json(response, 200, { apiVersion: 'v1', items, nextCursor: null });
    return;
  }
  const permanentDeleteMatch = /^\/api\/v1\/trash\/(art_[A-Za-z0-9_-]{22})$/u.exec(path);
  if (request.method === 'DELETE' && permanentDeleteMatch !== null) {
    const requestedArtifactId = permanentDeleteMatch[1];
    const value = JSON.parse(await body(request));
    const key = deletedArtifactKey(request, requestedArtifactId);
    if (value.confirmArtifactId !== requestedArtifactId) {
      json(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Invalid confirmation.' } });
      return;
    }
    if (!deletedArtifacts.has(key)) {
      json(response, 404, {
        error: { code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' },
      });
      return;
    }
    deletedArtifacts.delete(key);
    purgedArtifacts.add(key);
    json(response, 200, {
      apiVersion: 'v1',
      workspaceId,
      artifactId: requestedArtifactId,
      status: 'purged',
    });
    return;
  }
  const createdWorkspaceArtifacts = /^\/api\/v1\/workspaces\/([^/]+)\/artifacts$/u.exec(path);
  if (
    createdWorkspaceArtifacts !== null &&
    createdWorkspaces.has(createdWorkspaceKey(request, createdWorkspaceArtifacts[1]))
  ) {
    json(response, 200, { apiVersion: 'v1', items: [], nextCursor: null });
    return;
  }
  const recoveryMatch = /^\/api\/v1\/artifacts\/(art_[A-Za-z0-9_-]{22})\/recovery$/u.exec(path);
  if (request.method === 'POST' && recoveryMatch !== null) {
    const requestedArtifactId = recoveryMatch[1];
    const artifact = artifactsById.get(requestedArtifactId);
    const deletionKey = deletedArtifactKey(request, requestedArtifactId);
    if (artifact === undefined || !deletedArtifacts.has(deletionKey)) {
      json(response, 404, {
        error: {
          code: 'ARTIFACT_NOT_FOUND',
          message: 'Artifact not found.',
          retryable: false,
          requestId: 'request-browser-recovery',
        },
      });
      return;
    }
    deletedArtifacts.delete(deletionKey);
    json(response, 200, {
      apiVersion: 'v1',
      artifact: {
        ...artifact,
        retention: { mode: 'automatic', trashAt: '2026-08-25T12:00:00.000Z' },
      },
      recoveryShare: {
        apiVersion: 'v1',
        workspaceId,
        artifactId: requestedArtifactId,
        shareId: `shr_${'r'.repeat(22)}`,
        visibility: 'unlisted',
        accessType: 'protected',
        commentPolicy: 'off',
        target: { mode: 'latest' },
        createdAt: '2026-08-18T12:00:00.000Z',
        expiresAt: '2026-08-25T12:00:00.000Z',
        maxSessions: null,
        sessionsUsed: 0,
        sessionsRemaining: null,
        revokedAt: null,
        status: 'active',
        url: `/s/shr_${'r'.repeat(22)}#${'c'.repeat(32)}`,
        requestId: 'request-browser-recovery',
        replayed: false,
      },
    });
    return;
  }
  const deleteMatch = /^\/api\/v1\/artifacts\/(art_[A-Za-z0-9_-]{22})$/u.exec(path);
  if (request.method === 'DELETE' && deleteMatch !== null) {
    const requestedArtifactId = deleteMatch[1];
    if (
      !artifactsById.has(requestedArtifactId) ||
      purgedArtifacts.has(deletedArtifactKey(request, requestedArtifactId))
    ) {
      json(response, 404, {
        error: {
          code: 'ARTIFACT_NOT_FOUND',
          message: 'Artifact not found.',
          retryable: false,
          requestId: 'request-browser-deletion',
        },
      });
      return;
    }
    deletedArtifacts.add(deletedArtifactKey(request, requestedArtifactId));
    json(response, 200, {
      apiVersion: 'v1',
      workspaceId,
      artifactId: requestedArtifactId,
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
      reason: 'manual',
      revokedShareCount: requestedArtifactId === artifactPage.items[0]?.artifactId ? 2 : 0,
    });
    return;
  }
  const artifactMatch = /^\/api\/v1\/artifacts\/(art_[A-Za-z0-9_-]{22})(\/revisions)?$/u.exec(path);
  if (artifactMatch !== null) {
    const requestedArtifactId = artifactMatch[1];
    if (
      deletedArtifacts.has(deletedArtifactKey(request, requestedArtifactId)) ||
      purgedArtifacts.has(deletedArtifactKey(request, requestedArtifactId))
    ) {
      json(response, 404, {
        error: {
          code: 'ARTIFACT_NOT_FOUND',
          message: 'Artifact not found.',
          retryable: false,
          requestId: 'request-browser-artifact',
        },
      });
      return;
    }
    const history = historiesByArtifactId.get(requestedArtifactId);
    let value = artifactMatch[2] === undefined ? artifactsById.get(requestedArtifactId) : history;
    if (
      artifactMatch[2] !== undefined &&
      history !== undefined &&
      url.searchParams.get('order') === 'oldest'
    ) {
      value = { ...history, items: [...history.items].reverse() };
    }
    if (value !== undefined) {
      json(response, 200, value);
      return;
    }
  }
  const createShareMatch = new RegExp(
    `^/api/v1/workspaces/${workspaceId}/artifacts/(art_[A-Za-z0-9_-]{22})/shares$`,
    'u',
  ).exec(path);
  const defaultSharesMatch = new RegExp(
    `^/api/v1/workspaces/${workspaceId}/artifacts/(art_[A-Za-z0-9_-]{22})/shares/defaults$`,
    'u',
  ).exec(path);
  if (request.method === 'POST' && defaultSharesMatch !== null) {
    const requestedArtifactId = defaultSharesMatch[1];
    const common = {
      apiVersion: 'v1',
      workspaceId,
      artifactId: requestedArtifactId,
      visibility: 'unlisted',
      target: { mode: 'latest' },
      createdAt: '2026-08-18T10:10:00.000Z',
      expiresAt: null,
      revokedAt: null,
      status: 'active',
    };
    json(response, 200, {
      apiVersion: 'v1',
      workspaceId,
      artifactId: requestedArtifactId,
      protected: {
        ...common,
        shareId: createdShareId,
        accessType: 'protected',
        maxSessions: null,
        sessionsUsed: 0,
        sessionsRemaining: null,
        url: `/s/${createdShareId}#${shareSecret}`,
      },
      public: {
        ...common,
        shareId: `shr_${'u'.repeat(22)}`,
        accessType: 'public',
        publicCode: 'DefaultPub12',
        url: '/s/DefaultPub12',
      },
    });
    return;
  }
  if (request.method === 'POST' && createShareMatch !== null) {
    const requestedArtifactId = createShareMatch[1];
    const value = JSON.parse(await body(request));
    const validTarget =
      value.target?.mode === 'latest' ||
      (value.target?.mode === 'pinned' && typeof value.target.revisionId === 'string');
    if (
      request.headers['idempotency-key'] === undefined ||
      (value.accessType !== 'protected' && value.accessType !== 'public') ||
      value.expiresIn !== 'never' ||
      !validTarget ||
      !artifactsById.has(requestedArtifactId)
    ) {
      json(response, 400, {
        apiVersion: 'v1',
        error: { code: 'INVALID_REQUEST', message: 'Unexpected fixture share request.' },
      });
      return;
    }
    const isPublic = value.accessType === 'public';
    json(response, 201, {
      apiVersion: 'v1',
      requestId: 'request-browser-share',
      workspaceId,
      shareId: isPublic ? `shr_${'u'.repeat(22)}` : createdShareId,
      artifactId: requestedArtifactId,
      visibility: 'unlisted',
      accessType: value.accessType,
      target: value.target,
      createdAt: '2026-08-18T10:10:00.000Z',
      expiresAt: null,
      revokedAt: null,
      status: 'active',
      ...(isPublic
        ? { publicCode: 'DefaultPub12', url: '/s/DefaultPub12' }
        : {
            maxSessions: null,
            sessionsUsed: 0,
            sessionsRemaining: null,
            url: `/s/${createdShareId}#${shareSecret}`,
          }),
      replayed: false,
    });
    return;
  }
  if (request.method === 'GET' && path === `/api/v1/workspaces/${workspaceId}/shares`) {
    json(response, 200, sharePage);
    return;
  }
  const commentsMatch =
    /^\/api\/v1\/workspaces\/([^/]+)\/artifacts\/(art_[A-Za-z0-9_-]{22})\/comments$/u.exec(path);
  if (request.method === 'GET' && commentsMatch !== null) {
    const requestedArtifactId = commentsMatch[2];
    json(response, 200, {
      items: commentThreads.filter((thread) => thread.artifactId === requestedArtifactId),
      nextCursor: null,
    });
    return;
  }
  if (
    request.method === 'POST' &&
    path === `/api/v1/workspaces/${workspaceId}/comments/summaries`
  ) {
    const value = JSON.parse(await body(request));
    const requestedArtifactIds = Array.isArray(value.artifactIds) ? value.artifactIds : [];
    json(response, 200, {
      items: commentSummaries.filter((summary) =>
        requestedArtifactIds.includes(summary.artifactId),
      ),
    });
    return;
  }
  if (path === `/api/v1/revisions/${folderTreePage.revisionId}/tree`) {
    json(response, 200, folderTreePage);
    return;
  }
  if (path === `/api/v1/revisions/${folderTreePage.revisionId}/tree/content`) {
    const requestedPath = url.searchParams.get('path');
    const entry = folderTreePage.items.find(
      (item) => item.kind === 'file' && item.path === requestedPath,
    );
    if (entry === undefined) {
      json(response, 404, {
        apiVersion: 'v1',
        error: { code: 'NOT_FOUND', message: 'The folder file is unavailable.' },
      });
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': `${entry.mediaType}; charset=utf-8`,
    });
    response.end(
      entry.mediaType === 'application/json'
        ? JSON.stringify({ artifact: entry.path, bytes: entry.byteCount })
        : `Contents of ${entry.path}`,
    );
    return;
  }
  const contentMatch = /^\/api\/v1\/revisions\/(rev_[A-Za-z0-9_-]{22})\/content$/u.exec(path);
  const fileRevision = contentMatch === null ? undefined : filesByRevisionId.get(contentMatch[1]);
  if (fileRevision !== undefined) {
    const contentType =
      fileRevision.mediaType.startsWith('text/') || fileRevision.mediaType === 'application/json'
        ? `${fileRevision.mediaType}; charset=utf-8`
        : fileRevision.mediaType;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': contentType,
    });
    response.end(
      fileRevision.revisionId === revisionId
        ? '# One useful idea\n\nA durable artifact should stay quick to share.'
        : fileRevision.mediaType === 'application/json'
          ? JSON.stringify({ result: 'qualified', scenarios: 184 })
          : fileRevision.originalFileName,
    );
    return;
  }
  if (request.method === 'POST' && path === '/api/v1/access-credentials') {
    const value = JSON.parse(await body(request));
    if (
      value.actorName !== 'browser-agent' ||
      value.expiresAt !== undefined ||
      !Array.isArray(value.grants) ||
      value.grants.length !== 1 ||
      value.grants[0]?.workspaceId !== workspaceId ||
      value.grants[0]?.action !== 'file.publish'
    ) {
      json(response, 400, {
        apiVersion: 'v1',
        error: { code: 'INVALID_REQUEST', message: 'Unexpected fixture credential request.' },
      });
      return;
    }
    json(response, 201, {
      apiVersion: 'v1',
      credentialId: createdCredentialId,
      actorId: 'actor-browser-created-agent',
      actorName: value.actorName,
      token: createdCredentialToken,
      expiresAt: null,
      grants: value.grants,
    });
    return;
  }
  if (request.method === 'GET' && path === '/api/v1/access-credentials') {
    const requestedWorkspaceId = url.searchParams.get('workspaceId');
    json(response, 200, {
      ...credentialPage,
      items: credentialPage.items.filter(
        (credential) =>
          requestedWorkspaceId === null ||
          credential.grants.some((grant) => grant.workspaceId === requestedWorkspaceId),
      ),
    });
    return;
  }
  if (path === '/api/v1/public/config') {
    json(response, 200, { apiVersion: 'v1', rendererOrigin });
    return;
  }
  const sessionMatch = /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/sessions$/u.exec(path);
  if (request.method === 'POST' && sessionMatch !== null) {
    const value = JSON.parse(await body(request));
    const knownShare =
      [markdownShareId, htmlShareId].includes(sessionMatch[1]) ||
      richFixturesByShareId.has(sessionMatch[1]);
    const validSession =
      typeof value.sessionId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        value.sessionId,
      );
    const validAuthority =
      (value.secret === shareSecret && Object.keys(value).length === 2) ||
      (value.token === viewerToken && Object.keys(value).length === 2);
    if (!knownShare || !validSession || !validAuthority) {
      json(response, 404, {});
      return;
    }
    const result = {
      apiVersion: 'v1',
      shareId: sessionMatch[1],
      sessionId: value.sessionId,
      token: viewerToken,
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-20T00:00:00.000Z',
    };
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `shelf_viewer_session_${sessionMatch[1]}=${viewerCookieToken}; Path=/api/v1/public/shares/${sessionMatch[1]}; HttpOnly; SameSite=Strict`,
    });
    response.end(JSON.stringify(result));
    return;
  }
  if (
    request.method === 'POST' &&
    (path === `/api/v1/public/shares/${markdownShareId}/resolve` ||
      path === `/api/v1/public/shares/${htmlShareId}/resolve`)
  ) {
    const value = JSON.parse(await body(request));
    if (value.token !== viewerToken || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    json(response, 200, path.includes(markdownShareId) ? markdownResolution : htmlResolution);
    return;
  }
  if (
    request.method === 'POST' &&
    (path === `/api/v1/public/shares/${markdownShareId}/content` ||
      path === `/api/v1/public/shares/${htmlShareId}/content`)
  ) {
    const value = JSON.parse(await body(request));
    if (value.token !== viewerToken || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    const isMarkdown = path.includes(markdownShareId);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': isMarkdown ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
    });
    response.end(
      isMarkdown
        ? '# One useful idea\n\nA durable artifact should stay quick to share.'
        : '<!doctype html><html lang="en"><title>One useful idea</title><body><p>A durable artifact should stay quick to share.</p></body></html>',
    );
    return;
  }
  const protectedResolutionMatch =
    /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/resolve$/u.exec(path);
  if (request.method === 'POST' && protectedResolutionMatch !== null) {
    const value = JSON.parse(await body(request));
    const fixture = richFixturesByShareId.get(protectedResolutionMatch[1]);
    if (fixture === undefined || value.token !== viewerToken || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    json(response, 200, fixture.resolution);
    return;
  }
  const protectedContentMatch =
    /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/content$/u.exec(path);
  if (request.method === 'POST' && protectedContentMatch !== null) {
    const value = JSON.parse(await body(request));
    const fixture = richFixturesByShareId.get(protectedContentMatch[1]);
    if (fixture === undefined || value.token !== viewerToken || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    await sendRichContent(request, response, fixture);
    return;
  }
  const protectedPreviewMatch =
    /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/content\/preview$/u.exec(path);
  if (request.method === 'GET' && protectedPreviewMatch !== null) {
    const fixture = richFixturesByShareId.get(protectedPreviewMatch[1]);
    if (fixture === undefined || !hasViewerCookie(request, protectedPreviewMatch[1])) {
      json(response, 404, {});
      return;
    }
    previewRequests.push({ shareId: fixture.shareId, url: request.url });
    await sendRichContent(request, response, fixture, { preview: true });
    return;
  }
  const publicResolutionMatch = /^\/api\/v1\/public\/links\/([A-Za-z0-9_-]{12})\/resolve$/u.exec(
    path,
  );
  if (request.method === 'GET' && publicResolutionMatch !== null) {
    const fixture = richFixturesByPublicCode.get(publicResolutionMatch[1]);
    if (fixture === undefined) {
      json(response, 404, {});
      return;
    }
    json(response, 200, fixture.resolution);
    return;
  }
  const publicContentMatch = /^\/api\/v1\/public\/links\/([A-Za-z0-9_-]{12})\/content$/u.exec(path);
  if (request.method === 'GET' && publicContentMatch !== null) {
    const fixture = richFixturesByPublicCode.get(publicContentMatch[1]);
    if (fixture === undefined) {
      json(response, 404, {});
      return;
    }
    await sendRichContent(request, response, fixture);
    return;
  }
  const publicPreviewMatch =
    /^\/api\/v1\/public\/links\/([A-Za-z0-9_-]{12})\/content\/preview$/u.exec(path);
  if (request.method === 'GET' && publicPreviewMatch !== null) {
    const fixture = richFixturesByPublicCode.get(publicPreviewMatch[1]);
    if (fixture === undefined) {
      json(response, 404, {});
      return;
    }
    previewRequests.push({ shareId: fixture.shareId, url: request.url });
    await sendRichContent(request, response, fixture, { preview: true });
    return;
  }
  // The viewer queries discussions on mount. Neither fixture share enables a comment policy, so
  // the fixture answers with an empty page instead of a 404 the viewer would surface as an error.
  const viewerCommentsMatch =
    /^\/api\/v1\/public\/(?:shares\/shr_[A-Za-z0-9_-]{22}|links\/[A-Za-z0-9_-]{12})\/comments\/query$/u.test(
      path,
    );
  if (request.method === 'POST' && viewerCommentsMatch) {
    const value = JSON.parse(await body(request));
    if (path.includes('/shares/') && value.token !== viewerToken) {
      json(response, 404, {});
      return;
    }
    json(response, 200, { items: [], nextCursor: null });
    return;
  }
  json(response, 404, {
    apiVersion: 'v1',
    error: { code: 'NOT_FOUND', message: 'Fixture route not found.' },
  });
}

async function staticFile(request, response, url) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const candidate = resolve(fixtureRoot, `.${decodedPath}`);
  if (candidate !== fixtureRoot && !candidate.startsWith(fixtureRoot + sep)) {
    response.writeHead(400);
    response.end();
    return;
  }
  let file = candidate;
  let handle;
  try {
    handle = await open(file, 'r');
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      handle = undefined;
    }
  } catch {
    await handle?.close();
    handle = undefined;
  }
  if (handle === undefined) {
    const acceptsDocument = (request.headers.accept ?? '').includes('text/html');
    const isClientRoute =
      decodedPath === '/' ||
      decodedPath === '/signin' ||
      decodedPath === '/app' ||
      decodedPath.startsWith('/app/') ||
      /^\/s\/(?:shr_[A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{12})\/?$/u.test(decodedPath);
    if (!isClientRoute || (decodedPath !== '/' && !acceptsDocument)) {
      response.writeHead(404, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    file = resolve(fixtureRoot, 'index.html');
    handle = await open(file, 'r');
  }
  const contentType = mimeTypes.get(extname(file)) ?? 'application/octet-stream';
  const isDocument = file.endsWith('index.html');
  response.writeHead(200, {
    ...(isDocument
      ? documentHeaders
      : {
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        }),
    'content-type': contentType,
  });
  if (request.method === 'HEAD') response.end();
  else handle.createReadStream().pipe(response);
  if (request.method === 'HEAD') await handle.close();
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:43873');
    if (url.pathname === '/api/v1/renderer-canary') {
      const run = url.searchParams.get('run') ?? '';
      if (rendererFrameName.test(run)) {
        rendererCanaryHits.set(run, (rendererCanaryHits.get(run) ?? 0) + 1);
      }
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
    } else if (url.pathname === '/__fixture/renderer-canary-hits') {
      const run = url.searchParams.get('run') ?? '';
      json(response, 200, { hits: rendererCanaryHits.get(run) ?? 0 });
    } else if (url.pathname === '/__fixture/preview-requests') {
      json(response, 200, { requests: previewRequests });
    } else if (url.pathname === '/__fixture/cookie-scope') {
      const cookie = request.headers.cookie ?? '';
      json(response, 200, {
        protectedCookieOnUnscopedPath: [...richFixturesByShareId.keys()].some((shareId) =>
          cookie.includes(`shelf_viewer_session_${shareId}=`),
        ),
      });
    } else if (url.pathname === '/__fixture/history-anchor') {
      response.writeHead(200, {
        ...documentHeaders,
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(
        '<!doctype html><html lang="en"><title>History anchor</title><body></body></html>',
      );
    } else if (url.pathname === '/__fixture/axe.js') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/javascript; charset=utf-8',
        'x-content-type-options': 'nosniff',
      });
      response.end(axe.source);
    } else if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else await staticFile(request, response, url);
  })().catch(() => {
    if (!response.headersSent) json(response, 500, {});
    else response.destroy();
  });
});

server.listen(43873, '127.0.0.1');

function stop() {
  server.close(() => {
    process.exitCode = 0;
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
