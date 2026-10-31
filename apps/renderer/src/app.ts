import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  type ContentByteRange,
  normalizePortableFolderPath,
  type ShareResolutionAuthority,
} from '@shelf/core';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { folderSessionFileUrl, rewritePublicPreviewReferences } from './folder-assets.js';
import {
  createFolderSessionCodec,
  FOLDER_SESSION_TTL_MS,
  type FolderSessionClaims,
} from './folder-session.js';
import {
  artifactContentSecurityPolicy,
  bootstrapContentSecurityPolicy,
  DENIED_PERMISSIONS_POLICY,
  FOLDER_FILE_CONTENT_SECURITY_POLICY,
  folderDocumentContentSecurityPolicy,
  validatedAppOrigin,
  validatedTrustedResourceOrigins,
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
  ): Promise<RendererHtmlResolution>;
  /** Required when `resolveHtml` can return a folder grant. */
  readFolderFile?(request: {
    authority: ShareResolutionAuthority;
    revisionId: string;
    path: string;
    signal?: AbortSignal;
  }): Promise<RendererFolderFile | undefined>;
}

export type RendererHtmlResolution =
  | { status: 'available'; html: string }
  | {
      status: 'folder';
      authority: ShareResolutionAuthority;
      revisionId: string;
      path: string;
      accessExpiresAt?: number;
    }
  | { status: 'unavailable' };

export type RendererFolderFile =
  | { kind: 'html'; html: string }
  | {
      kind: 'file';
      mediaType: string;
      byteCount: number;
      read(range?: ContentByteRange): Promise<AsyncIterable<Uint8Array>>;
    };

export interface CreateRendererAppOptions {
  appOrigin: string;
  trustedResourceOrigins?: readonly string[];
  readTrustedResourceOrigins?: () => Promise<readonly string[]>;
  resolver: RendererHtmlResolver;
  handlerTimeoutMs?: number;
  /** Signs folder sessions. Defaults to a per-process random key. */
  folderSessionKey?: Uint8Array;
  clock?: () => Date;
}

const BOOTSTRAP_DOCUMENT =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shelf renderer</title></head><body></body></html>';
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
const VIEWER_TOKEN_PATTERN = /^[A-Za-z0-9._-]{24,4096}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const REVISION_ID_PATTERN = /^rev_[A-Za-z0-9_-]{22}$/u;
const FOLDER_SESSION_ROUTE = /^\/f\/([^/?#]+)\/([^?#]*)(?:\?[^#]*)?$/u;
const RENDERER_HOST_PATTERN = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/u;
const FOLDER_INDEX_FILE = 'index.html';
// RFC 3986 fragment characters, already percent-encoded by the document's URL parser.
const FRAGMENT_PATTERN = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]{1,1024}$/u;

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
  /** A folder link's target fragment, applied to the folder session redirect. */
  fragment?: string;
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
  const fragmentValues = parameters.getAll('fragment');
  const fragment = fragmentValues[0];
  if (
    fragmentValues.length > 1 ||
    (fragment !== undefined && (path === undefined || !FRAGMENT_PATTERN.test(fragment)))
  ) {
    return { nonce };
  }
  const keys = [...parameters.keys()].filter((key) => key !== 'fragment');
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
          ...(fragment === undefined ? {} : { fragment }),
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
          ...(fragment === undefined ? {} : { fragment }),
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
  folderSessionPath?: string,
  retryable = false,
): string {
  const nonceLiteral = javascriptLiteral(nonce);
  const originLiteral = javascriptLiteral(appOrigin);
  const typeLiteral = javascriptLiteral(type);
  // The parent reference is captured before authored scripts can replace `window.parent`.
  // The signal follows DOMContentLoaded, not window load, so slow images and fonts cannot keep
  // the viewer waiting past its readiness deadline.
  // Same-document fragment links update history without a navigation, because WebKit fires the
  // frame's load event for fragment navigation and the parent terminates every later load.
  // In a folder session, same-folder links ask the parent viewer to open that file instead.
  const folderLinks =
    folderSessionPath === undefined
      ? ''
      : `if(!url.pathname.startsWith(${javascriptLiteral(folderSessionPath)}))return;event.preventDefault();let path;try{path=decodeURIComponent(url.pathname.slice(${folderSessionPath.length}))}catch{return}if(path===""||path.endsWith("/"))path+="index.html";notify("shelf:renderer-open-path",{path,fragment:url.hash.slice(1)});`;
  const links = `const closest=Element.prototype.closest;addEventListener("click",event=>{if(event.defaultPrevented||event.button!==0||!(event.target instanceof Element))return;const anchor=closest.call(event.target,"a[href],area[href]");if(anchor===null)return;let url;try{url=new URL(anchor.getAttribute("href")??"",document.baseURI)}catch{return}if(url.origin!==location.origin)return;if(url.pathname===location.pathname&&url.search===location.search&&(url.hash!==""||url.href.endsWith("#"))){event.preventDefault();const oldURL=location.href;try{history.pushState(history.state,"",url.href)}catch{return}let id=url.hash.slice(1);try{id=decodeURIComponent(id)}catch{}const target=id===""||id.toLowerCase()==="top"?document.documentElement:document.getElementById(id)??document.getElementsByName(id)[0];target?.scrollIntoView();if(oldURL!==location.href)dispatchEvent(new HashChangeEvent("hashchange",{oldURL,newURL:location.href}));return}${folderLinks}});`;
  return `<script>(()=>{const target=parent;const channel=Array.from(crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,"0")).join("");const notify=(type,detail)=>target.postMessage({...detail,type,version:1,nonce:${nonceLiteral},channel},${originLiteral});notify("shelf:renderer-armed");document.addEventListener("DOMContentLoaded",()=>notify(${typeLiteral},${retryable ? '{retryable:true}' : '{}'}),{once:true});${links}})()</script>`;
}

function injectBeforeAuthoredScripts(html: string, script: string): string {
  const doctype = /^\s*<!doctype\s+html[^>]*>/iu.exec(html);
  if (doctype !== null) {
    return `${doctype[0]}${script}${html.slice(doctype[0].length)}`;
  }
  return `${script}${html}`;
}

function unavailableDocument(nonce: string, appOrigin: string, transient = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview unavailable</title>${signalScript('shelf:renderer-unavailable', nonce, appOrigin, undefined, transient)}</head><body></body></html>`;
}

function folderSessionRequest(
  rawUrl: string | undefined,
): { token: string; path: string } | undefined {
  const match = FOLDER_SESSION_ROUTE.exec(rawUrl ?? '');
  if (match === null) return undefined;
  try {
    const segments = (match[2] ?? '').split('/').map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment.includes('/'))) return undefined;
    const last = segments.length - 1;
    if (segments[last] === '') segments[last] = FOLDER_INDEX_FILE;
    return {
      token: match[1] ?? '',
      path: normalizePortableFolderPath(segments.join('/')),
    };
  } catch {
    return undefined;
  }
}

/** Parse one RFC 9110 byte range. Malformed or multiple ranges fall back to the full body. */
function requestedByteRange(
  value: string | undefined,
  size: number,
): ContentByteRange | 'unsatisfiable' | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (match === null) return undefined;
  const first = match[1] ?? '';
  const last = match[2] ?? '';
  if (first === '' && last === '') return undefined;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? Number.MAX_SAFE_INTEGER : Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

export async function createRendererApp(options: CreateRendererAppOptions): Promise<RendererApp> {
  const appOrigin = validatedAppOrigin(options.appOrigin);
  const trustedResourceOrigins = validatedTrustedResourceOrigins(
    options.trustedResourceOrigins ?? [],
    appOrigin,
  );
  const resourceOriginsForHost = async (host: string | undefined): Promise<readonly string[]> => {
    const currentOrigins =
      options.readTrustedResourceOrigins === undefined
        ? trustedResourceOrigins
        : validatedTrustedResourceOrigins(await options.readTrustedResourceOrigins(), appOrigin);
    if (currentOrigins.length === 0 || host === undefined || !RENDERER_HOST_PATTERN.test(host))
      return [];
    let hostname: string;
    try {
      hostname = new URL(`https://${host}`).hostname.replace(/\.$/u, '');
    } catch {
      return [];
    }
    // Trusting the renderer itself would allow another folder session's assets.
    return currentOrigins.filter(
      (origin) => new URL(origin).hostname.replace(/\.$/u, '') !== hostname,
    );
  };
  const bootstrapPolicy = bootstrapContentSecurityPolicy(appOrigin);
  const artifactPolicy = artifactContentSecurityPolicy(appOrigin);
  const folderSessions = createFolderSessionCodec(options.folderSessionKey);
  const now = options.clock ?? (() => new Date());
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

  const folderReadable = options.resolver.readFolderFile !== undefined;

  app.get('/f/*', async (request, reply) => {
    const route = folderSessionRequest(request.raw.url);
    const claims: FolderSessionClaims | undefined =
      route === undefined ? undefined : folderSessions.verify(route.token, now());
    const readFolderFile = options.resolver.readFolderFile;
    const origin = request.headers.origin;
    const destination = request.headers['sec-fetch-dest'];
    if (
      route === undefined ||
      claims === undefined ||
      readFolderFile === undefined ||
      request.headers.cookie !== undefined ||
      (origin !== undefined && origin !== 'null') ||
      destination === 'document'
    ) {
      applyBoundaryHeaders(reply, FOLDER_FILE_CONTENT_SECURITY_POLICY);
      return reply.status(404).send();
    }
    const file = await readFolderFile({
      authority: claims.authority,
      revisionId: claims.revisionId,
      path: route.path,
      signal: requestCancellationSignal(request, reply),
    }).catch(() => null);

    // Only the sandboxed viewer frame may load a folder document. Browsers without Fetch Metadata
    // omit the destination, so an HTML file then loads as a document too.
    if (destination === 'iframe' || (destination === undefined && file?.kind === 'html')) {
      const host = request.headers.host;
      if (
        file === null ||
        file === undefined ||
        file.kind !== 'html' ||
        host === undefined ||
        !RENDERER_HOST_PATTERN.test(host)
      ) {
        applyBoundaryHeaders(reply, artifactPolicy);
        return reply
          .status(file === null ? 503 : 404)
          .type('text/html; charset=utf-8')
          .send(unavailableDocument(claims.nonce, appOrigin, file === null));
      }
      const sessionPath = `/f/${route.token}/`;
      // The renderer may sit behind a TLS-terminating proxy, so name the session path for both schemes.
      applyBoundaryHeaders(
        reply,
        folderDocumentContentSecurityPolicy(
          appOrigin,
          `https://${host}${sessionPath} http://${host}${sessionPath}`,
        ),
      );
      const html =
        claims.authority.type === 'public'
          ? rewritePublicPreviewReferences({
              html: file.html,
              appOrigin,
              publicCode: claims.authority.publicCode,
              sessionPath,
            })
          : file.html;
      const ready = signalScript('shelf:renderer-ready', claims.nonce, appOrigin, sessionPath);
      return reply.type('text/html; charset=utf-8').send(injectBeforeAuthoredScripts(html, ready));
    }

    applyBoundaryHeaders(reply, FOLDER_FILE_CONTENT_SECURITY_POLICY);
    // Module scripts, fonts, and fetch() from the opaque sandbox origin use CORS, so failures
    // carry the header too and scripts can read their status.
    void reply.header('Access-Control-Allow-Origin', '*');
    if (file === null) return reply.status(503).send();
    if (file === undefined) return reply.status(404).send();
    if (file.kind === 'html') return reply.type('text/html; charset=utf-8').send(file.html);
    void reply.header('Accept-Ranges', 'bytes');
    void reply.type(file.mediaType);
    const range = requestedByteRange(request.headers.range, file.byteCount);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('Content-Range', `bytes */${file.byteCount}`).send();
    }
    const status = range === undefined ? 200 : 206;
    void reply.header(
      'Content-Length',
      String(range === undefined ? file.byteCount : range.end - range.start + 1),
    );
    if (range !== undefined) {
      void reply.header('Content-Range', `bytes ${range.start}-${range.end}/${file.byteCount}`);
    }
    if (file.byteCount === 0) return reply.status(status).send('');
    let content: AsyncIterable<Uint8Array>;
    try {
      content = await file.read(range);
    } catch {
      return reply.status(503).removeHeader('Content-Length').send();
    }
    // The handler deadline bounds the lookup above. Streaming a large file can outlast it, so the
    // body is written outside Fastify's reply lifecycle.
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(status);
    await pipeline(Readable.from(content), reply.raw).catch(() => reply.raw.destroy());
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
        .send(unavailableDocument(input.nonce, appOrigin, true));
    }
    if (result.status === 'unavailable' || (result.status === 'folder' && !folderReadable)) {
      return reply
        .status(404)
        .type('text/html; charset=utf-8')
        .send(unavailableDocument(input.nonce, appOrigin));
    }
    if (result.status === 'folder') {
      const token = folderSessions.issue({
        authority: result.authority,
        revisionId: result.revisionId,
        nonce: input.nonce,
        expiresAt: Math.min(
          now().getTime() + FOLDER_SESSION_TTL_MS,
          result.accessExpiresAt ?? Number.POSITIVE_INFINITY,
        ),
      });
      // A real hierarchical document URL lets the browser resolve relative references itself.
      return reply
        .status(303)
        .header(
          'Location',
          `${folderSessionFileUrl(`/f/${token}/`, result.path)}${
            input.fragment === undefined ? '' : `#${input.fragment}`
          }`,
        )
        .send();
    }
    let origins: readonly string[];
    try {
      origins = await resourceOriginsForHost(request.headers.host);
    } catch {
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(unavailableDocument(input.nonce, appOrigin, true));
    }
    const ready = signalScript('shelf:renderer-ready', input.nonce, appOrigin);
    applyBoundaryHeaders(reply, artifactContentSecurityPolicy(appOrigin, origins));
    return reply
      .type('text/html; charset=utf-8')
      .send(injectBeforeAuthoredScripts(result.html, ready));
  });

  await app.ready();
  return app;
}
