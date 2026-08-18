import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import axe from 'axe-core';

import {
  artifactId,
  artifactPage,
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
  sharePage,
  shareSecret,
  workspaceId,
} from './fixtures.ts';

const artifactsById = new Map(
  artifactPage.items.map((artifact) => [artifact.artifactId, artifact]),
);
const historiesByArtifactId = new Map(historyPages.map((page) => [page.artifactId, page]));
const latestFilesByRevisionId = new Map(
  artifactPage.items.flatMap((artifact) =>
    artifact.latestRevision.kind === 'file'
      ? [[artifact.latestRevision.revisionId, artifact.latestRevision]]
      : [],
  ),
);

const fixtureRoot = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
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
    "img-src 'self' data: blob:",
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

async function api(request, response, url) {
  const path = url.pathname;
  if (path === '/api/v1/dashboard/session') {
    if ((request.headers.cookie ?? '').includes('shelf-browser-anonymous=1')) {
      response.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain' });
      response.end('Authentication required.');
      return;
    }
    json(response, 200, dashboardSession);
    return;
  }
  if (path === `/api/v1/workspaces/${workspaceId}/artifacts`) {
    json(response, 200, artifactPage);
    return;
  }
  const artifactMatch = /^\/api\/v1\/artifacts\/(art_[A-Za-z0-9_-]{22})(\/revisions)?$/u.exec(path);
  if (artifactMatch !== null) {
    const requestedArtifactId = artifactMatch[1];
    const value =
      artifactMatch[2] === undefined
        ? artifactsById.get(requestedArtifactId)
        : historiesByArtifactId.get(requestedArtifactId);
    if (value !== undefined) {
      json(response, 200, value);
      return;
    }
  }
  if (
    request.method === 'POST' &&
    path === `/api/v1/workspaces/${workspaceId}/artifacts/${artifactId}/shares`
  ) {
    const value = JSON.parse(await body(request));
    if (
      request.headers['idempotency-key'] === undefined ||
      value.expiresAt !== null ||
      value.target?.mode !== 'pinned' ||
      typeof value.target.revisionId !== 'string'
    ) {
      json(response, 400, {
        apiVersion: 'v1',
        error: { code: 'INVALID_REQUEST', message: 'Unexpected fixture share request.' },
      });
      return;
    }
    json(response, 201, {
      apiVersion: 'v1',
      requestId: 'request-browser-share',
      workspaceId,
      shareId: createdShareId,
      artifactId,
      visibility: 'unlisted',
      target: value.target,
      createdAt: '2026-08-18T10:10:00.000Z',
      expiresAt: null,
      revokedAt: null,
      url: `/s/${createdShareId}#${shareSecret}`,
      replayed: false,
    });
    return;
  }
  if (request.method === 'GET' && path === `/api/v1/workspaces/${workspaceId}/shares`) {
    json(response, 200, sharePage);
    return;
  }
  if (path === `/api/v1/revisions/${folderTreePage.revisionId}/tree`) {
    json(response, 200, folderTreePage);
    return;
  }
  const contentMatch = /^\/api\/v1\/revisions\/(rev_[A-Za-z0-9_-]{22})\/content$/u.exec(path);
  const fileRevision =
    contentMatch === null ? undefined : latestFilesByRevisionId.get(contentMatch[1]);
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
    json(response, 200, credentialPage);
    return;
  }
  if (path === '/api/v1/public/config') {
    json(response, 200, { apiVersion: 'v1', rendererOrigin });
    return;
  }
  if (
    request.method === 'POST' &&
    (path === `/api/v1/public/shares/${markdownShareId}/resolve` ||
      path === `/api/v1/public/shares/${htmlShareId}/resolve`)
  ) {
    const value = JSON.parse(await body(request));
    if (value.secret !== shareSecret || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    json(response, 200, path.includes(markdownShareId) ? markdownResolution : htmlResolution);
    return;
  }
  if (request.method === 'POST' && path === `/api/v1/public/shares/${markdownShareId}/content`) {
    const value = JSON.parse(await body(request));
    if (value.secret !== shareSecret || Object.keys(value).length !== 1) {
      json(response, 404, {});
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/markdown; charset=utf-8',
    });
    response.end('# One useful idea\n\nA durable artifact should stay quick to share.');
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
      /^\/s\/shr_[A-Za-z0-9_-]{22}\/?$/u.test(decodedPath);
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
