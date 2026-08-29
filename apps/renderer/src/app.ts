import { normalizePortableFolderPath } from '@shelf/core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import {
  artifactContentSecurityPolicy,
  bootstrapContentSecurityPolicy,
  DENIED_PERMISSIONS_POLICY,
  validatedAppOrigin,
} from './policy.js';
import { requestCancellationSignal } from './request-cancellation.js';

export type RendererApp = FastifyInstance;

export interface RendererHtmlResolver {
  resolveHtml(
    request:
      | {
          accessType: 'protected';
          shareId: string;
          viewerToken: string;
          revisionId?: string;
          path?: string;
          signal?: AbortSignal;
        }
      | {
          accessType: 'public';
          publicCode: string;
          revisionId?: string;
          path?: string;
          signal?: AbortSignal;
        },
  ): Promise<{ status: 'available'; html: string } | { status: 'unavailable' }>;
}

export interface CreateRendererAppOptions {
  appOrigin: string;
  resolver: RendererHtmlResolver;
  handlerTimeoutMs?: number;
}

const BOOTSTRAP_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shelf renderer</title></head><body></body></html>';
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
const VIEWER_TOKEN_PATTERN = /^[A-Za-z0-9._-]{24,4096}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const REVISION_ID_PATTERN = /^rev_[A-Za-z0-9_-]{22}$/u;

function applyBoundaryHeaders(reply: FastifyReply, contentSecurityPolicy: string): void {
  void reply.header('Cache-Control', 'no-store, no-transform');
  void reply.header('Content-Security-Policy', contentSecurityPolicy);
  void reply.header('Permissions-Policy', DENIED_PERMISSIONS_POLICY);
  void reply.header('Referrer-Policy', 'no-referrer');
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function parseRenderRequest(body: unknown): {
  nonce: string;
  request?:
    | {
        accessType: 'protected';
        shareId: string;
        viewerToken: string;
        revisionId?: string;
        path?: string;
      }
    | { accessType: 'public'; publicCode: string; revisionId?: string; path?: string };
} {
  if (typeof body !== 'string') return { nonce: '' };
  const parameters = new URLSearchParams(body);
  const nonceValues = parameters.getAll('nonce');
  const nonce =
    nonceValues.length === 1 && NONCE_PATTERN.test(nonceValues[0] ?? '')
      ? (nonceValues[0] ?? '')
      : '';
  if (nonce === '') return { nonce };
  const pathValues = parameters.getAll('path');
  if (pathValues.length > 1) return { nonce };
  let path: string | undefined;
  if (pathValues.length === 1) {
    try {
      path = normalizePortableFolderPath(pathValues[0] ?? '');
    } catch {
      return { nonce };
    }
  }
  const revisionValues = parameters.getAll('revisionId');
  if (revisionValues.length > 1) return { nonce };
  const revisionId = revisionValues[0];
  if (revisionId !== undefined && !REVISION_ID_PATTERN.test(revisionId)) return { nonce };
  const keys = [...parameters.keys()];
  const protectedBody = keys.every(
    (key) =>
      key === 'shareId' ||
      key === 'viewerToken' ||
      key === 'nonce' ||
      key === 'path' ||
      key === 'revisionId',
  );
  if (
    protectedBody &&
    parameters.getAll('shareId').length === 1 &&
    parameters.getAll('viewerToken').length === 1 &&
    parameters.getAll('nonce').length === 1
  ) {
    const shareId = parameters.get('shareId') ?? '';
    const viewerToken = parameters.get('viewerToken') ?? '';
    return SHARE_ID_PATTERN.test(shareId) && VIEWER_TOKEN_PATTERN.test(viewerToken)
      ? {
          nonce,
          request: {
            accessType: 'protected',
            shareId,
            viewerToken,
            ...(revisionId === undefined ? {} : { revisionId }),
            ...(path === undefined ? {} : { path }),
          },
        }
      : { nonce };
  }
  const publicBody = keys.every(
    (key) => key === 'publicCode' || key === 'nonce' || key === 'path' || key === 'revisionId',
  );
  if (
    publicBody &&
    parameters.getAll('publicCode').length === 1 &&
    parameters.getAll('nonce').length === 1
  ) {
    const publicCode = parameters.get('publicCode') ?? '';
    return PUBLIC_CODE_PATTERN.test(publicCode)
      ? {
          nonce,
          request: {
            accessType: 'public',
            publicCode,
            ...(revisionId === undefined ? {} : { revisionId }),
            ...(path === undefined ? {} : { path }),
          },
        }
      : { nonce };
  }
  return { nonce };
}

function javascriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function signalScript(
  type: 'shelf:renderer-ready' | 'shelf:renderer-unavailable',
  nonce: string,
  appOrigin: string,
): string {
  const nonceLiteral = javascriptLiteral(nonce);
  const originLiteral = javascriptLiteral(appOrigin);
  const typeLiteral = javascriptLiteral(type);
  return `<script>(()=>{const channel=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,"0")).join("");const notify=type=>parent.postMessage({type,version:1,nonce:${nonceLiteral},channel},${originLiteral});notify("shelf:renderer-armed");addEventListener("load",()=>notify(${typeLiteral}),{once:true})})()</script>`;
}

function injectBeforeAuthoredScripts(html: string, script: string): string {
  const doctype = /^\s*<!doctype\s+html[^>]*>/iu.exec(html);
  if (doctype !== null) {
    return `${doctype[0]}${script}${html.slice(doctype[0].length)}`;
  }
  return `${script}${html}`;
}

function unavailableDocument(nonce: string, appOrigin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview unavailable</title>${signalScript('shelf:renderer-unavailable', nonce, appOrigin)}</head><body></body></html>`;
}

export async function createRendererApp(options: CreateRendererAppOptions): Promise<RendererApp> {
  const appOrigin = validatedAppOrigin(options.appOrigin);
  const bootstrapPolicy = bootstrapContentSecurityPolicy(appOrigin);
  const artifactPolicy = artifactContentSecurityPolicy(appOrigin);
  // Request logging remains disabled at this boundary so a client cannot place a capability in a
  // URL and cause it to be persisted by the renderer process.
  const app = Fastify({
    logger: false,
    bodyLimit: 2_048,
    handlerTimeout: options.handlerTimeoutMs ?? 30_000,
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((error, request, reply) => {
    if (request.raw.url?.split('?', 1)[0] === '/render') {
      applyBoundaryHeaders(reply, artifactPolicy);
      return reply
        .status(
          typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'FST_ERR_HANDLER_TIMEOUT'
            ? 503
            : 404,
        )
        .type('text/html; charset=utf-8')
        .send(unavailableDocument('', appOrigin));
    }
    applyBoundaryHeaders(reply, bootstrapPolicy);
    return reply.status(404).type('text/html; charset=utf-8').send(BOOTSTRAP_DOCUMENT);
  });

  app.setNotFoundHandler((_request, reply) => {
    applyBoundaryHeaders(reply, bootstrapPolicy);
    return reply.status(404).type('text/html; charset=utf-8').send(BOOTSTRAP_DOCUMENT);
  });

  app.get('/', async (_request, reply) => {
    applyBoundaryHeaders(reply, bootstrapPolicy);
    return reply.type('text/html; charset=utf-8').send(BOOTSTRAP_DOCUMENT);
  });

  app.post('/render', async (request, reply) => {
    applyBoundaryHeaders(reply, artifactPolicy);
    const input = parseRenderRequest(request.body);
    if (
      request.raw.url !== '/render' ||
      request.headers.origin !== 'null' ||
      request.headers.cookie !== undefined ||
      input.request === undefined
    ) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(unavailableDocument(input.nonce, appOrigin));
    }
    let result: Awaited<ReturnType<RendererHtmlResolver['resolveHtml']>>;
    try {
      result = await options.resolver.resolveHtml({
        ...input.request,
        signal: requestCancellationSignal(request, reply),
      });
    } catch {
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(unavailableDocument(input.nonce, appOrigin));
    }
    if (result.status === 'unavailable') {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(unavailableDocument(input.nonce, appOrigin));
    }
    const ready = signalScript('shelf:renderer-ready', input.nonce, appOrigin);
    return reply
      .type('text/html; charset=utf-8')
      .send(injectBeforeAuthoredScripts(result.html, ready));
  });

  await app.ready();
  return app;
}
