import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRendererApp, type RendererApp } from '../src/app.js';
import { createCoreHtmlResolver } from '../src/resolver.js';
import {
  rendererDependencies,
  rendererFolderDependencies,
  rendererStoredShare,
} from './support/renderer-dependencies.js';

const apps: RendererApp[] = [];
const appOrigin = 'https://shelf.example';
const viewerToken = `${'v'.repeat(24)}.${'s'.repeat(43)}`;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const app = await createRendererApp({
    appOrigin,
    resolver: {
      async resolveHtml() {
        return { status: 'unavailable' };
      },
    },
  });
  apps.push(app);
  return app;
}

async function postRender(
  app: RendererApp,
  values: {
    shareId?: string;
    viewerToken?: string;
    publicCode?: string;
    nonce?: string;
    path?: string;
    revisionId?: string;
  } = {},
) {
  const path = values.path === undefined ? {} : { path: values.path };
  const revisionId = values.revisionId === undefined ? {} : { revisionId: values.revisionId };
  return app.inject({
    method: 'POST',
    url: '/render',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'null',
    },
    payload: new URLSearchParams(
      values.publicCode === undefined
        ? {
            shareId: values.shareId ?? 'shr_AAAAAAAAAAAAAAAAAAAAAA',
            viewerToken: values.viewerToken ?? viewerToken,
            nonce: values.nonce ?? 'n'.repeat(22),
            ...path,
            ...revisionId,
          }
        : {
            publicCode: values.publicCode,
            nonce: values.nonce ?? 'n'.repeat(22),
            ...path,
            ...revisionId,
          },
    ).toString(),
  });
}

describe('isolated HTML renderer', () => {
  it('serves an inert availability document with no active bootstrap permissions', async () => {
    const app = await fixture();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['permissions-policy']).not.toContain('ambient-light-sensor');
    expect(response.headers['content-security-policy']).not.toContain('navigate-to');
    expect(response.headers['content-security-policy']).toContain(`frame-ancestors ${appOrigin}`);
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(response.body).not.toContain('<script');
    expect(response.body).not.toMatch(/shareId|secret|postMessage/u);
  });

  it('keeps unknown routes inert and policy-bound', async () => {
    const app = await fixture();
    const secretCanary = 'secret-capability-canary';

    const response = await app.inject({
      method: 'GET',
      url: `/render?secret=${secretCanary}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['content-security-policy']).toContain("script-src 'none'");
    expect(response.body).not.toContain(secretCanary);
  });

  it('renders available HTML under the final artifact CSP and signals readiness without the secret', async () => {
    const resolveHtml = vi.fn(async () => ({
      status: 'available' as const,
      html: '<!doctype html><html><head><title>Demo</title></head><body><script>fetch("https://collector.invalid")</script><h1>Artifact</h1></body></html>',
    }));
    const app = await createRendererApp({ appOrigin, resolver: { resolveHtml } });
    apps.push(app);
    const token = viewerToken;
    const nonce = 'n'.repeat(22);

    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
      },
      payload: new URLSearchParams({
        shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
        viewerToken: token,
        nonce,
      }).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(response.headers['permissions-policy']).toContain('geolocation=()');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'unsafe-inline' data:",
    );
    expect(response.headers['content-security-policy']).toContain(
      "style-src 'unsafe-inline' blob:",
    );
    expect(response.headers['permissions-policy']).not.toContain('ambient-light-sensor');
    expect(response.headers['content-security-policy']).not.toContain('navigate-to');
    expect(response.headers['content-security-policy']).toContain("form-action 'none'");
    expect(response.headers['content-security-policy']).toContain("base-uri 'none'");
    expect(response.headers['content-security-policy']).toContain("object-src 'none'");
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(response.headers['content-security-policy']).toContain(`frame-ancestors ${appOrigin}`);
    expect(response.body).toContain('<h1>Artifact</h1>');
    expect(response.body).toContain('shelf:renderer-ready');
    expect(response.body).toContain('shelf:renderer-armed');
    expect(response.body).toContain('crypto.getRandomValues');
    expect(response.body).toContain('addEventListener("load"');
    expect(response.body).toContain(nonce);
    expect(response.body).not.toContain(token);
    expect(response.body.indexOf('shelf:renderer-ready')).toBeLessThan(
      response.body.indexOf('collector.invalid'),
    );
    expect(resolveHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        accessType: 'protected',
        shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
        viewerToken: token,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('renders Public HTML with only the selector and nonce', async () => {
    const resolveHtml = vi.fn(async () => ({
      status: 'available' as const,
      html: '<!doctype html><h1>Public artifact</h1>',
    }));
    const app = await createRendererApp({ appOrigin, resolver: { resolveHtml } });
    apps.push(app);

    const response = await postRender(app, { publicCode: 'AbCdEf0123_-' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Public artifact');
    expect(resolveHtml).toHaveBeenCalledWith(
      expect.objectContaining({ accessType: 'public', publicCode: 'AbCdEf0123_-' }),
    );
  });

  it('passes an exact portable folder path through the opaque form boundary', async () => {
    const resolveHtml = vi.fn(async () => ({
      status: 'available' as const,
      html: '<!doctype html><h1>Folder artifact</h1>',
    }));
    const app = await createRendererApp({ appOrigin, resolver: { resolveHtml } });
    apps.push(app);

    const response = await postRender(app, {
      publicCode: 'AbCdEf0123_-',
      path: 'site/index.html',
      revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Folder artifact');
    expect(resolveHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        accessType: 'public',
        publicCode: 'AbCdEf0123_-',
        path: 'site/index.html',
        revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      }),
    );
  });

  it('bounds a stalled renderer dependency and aborts its data-plane signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const app = await createRendererApp({
      appOrigin,
      handlerTimeoutMs: 20,
      resolver: {
        async resolveHtml(request) {
          observedSignal = request.signal;
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          });
          return { status: 'unavailable' };
        },
      },
    });
    apps.push(app);

    const response = await postRender(app);

    expect(response.statusCode).toBe(503);
    expect(observedSignal?.aborted).toBe(true);
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.body).toContain('shelf:renderer-unavailable');
  });

  it('accepts only exact discriminated authority from an opaque sandbox form body', async () => {
    const resolveHtml = vi.fn(async () => ({
      status: 'available' as const,
      html: '<!doctype html><title>Artifact</title>',
    }));
    const app = await createRendererApp({ appOrigin, resolver: { resolveHtml } });
    apps.push(app);
    const nonce = 'n'.repeat(22);
    const tokenCanary = viewerToken;
    const validBody = new URLSearchParams({
      shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
      viewerToken: tokenCanary,
      nonce,
    }).toString();
    const invalidRequests = [
      {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: validBody,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://attacker.example',
        },
        payload: validBody,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: appOrigin,
        },
        payload: validBody,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'shelf-session=must-not-reach-the-renderer',
          origin: 'null',
        },
        payload: validBody,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: `${validBody}&viewerToken=${encodeURIComponent(tokenCanary)}`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: `${validBody}&unexpected=value`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: validBody,
        url: `/render?viewerToken=${encodeURIComponent(tokenCanary)}`,
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: `${validBody}&publicCode=AbCdEf0123_-`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: `${validBody}&path=..%2Fprivate.html`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
        },
        payload: `${validBody}&path=site%2Findex.html&path=site%2Fother.html`,
        url: '/render',
      },
    ];

    for (const request of invalidRequests) {
      const response = await app.inject({ method: 'POST', ...request });
      expect(response.statusCode).toBe(404);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(response.body).toContain('shelf:renderer-unavailable');
      expect(response.body).not.toContain(tokenCanary);
    }
    expect(resolveHtml).not.toHaveBeenCalled();
  });

  it('returns the safe renderer document for rejected request bodies', async () => {
    const app = await fixture();

    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
      },
      payload: `nonce=${'n'.repeat(22)}&padding=${'x'.repeat(3_000)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.body).toContain('shelf:renderer-unavailable');
    expect(response.body).not.toMatch(/payload|too large|error|stack/i);
  });

  it('makes wrong, malformed, revoked, and expired viewer authority indistinguishable', async () => {
    const nonce = 'n'.repeat(22);
    const cases = [
      { dependencies: rendererDependencies(), token: `${'w'.repeat(24)}.${'x'.repeat(43)}` },
      { dependencies: rendererDependencies(), token: 'malformed' },
      {
        dependencies: rendererDependencies({
          share: rendererStoredShare({ revokedAt: '2026-08-17T12:15:00.000Z' }),
        }),
      },
      {
        dependencies: rendererDependencies({
          share: rendererStoredShare({ expiresAt: '2026-08-17T12:30:00.000Z' }),
        }),
      },
    ];
    const responses = [];
    for (const testCase of cases) {
      const app = await createRendererApp({
        appOrigin,
        resolver: createCoreHtmlResolver({
          appOrigin,
          ...testCase.dependencies,
          viewerSessionTokenCodec: {
            verify: (token) =>
              token === viewerToken
                ? {
                    shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
                    sessionId: '123e4567-e89b-42d3-a456-426614174000',
                    issuedAt: '2026-08-17T12:00:00.000Z',
                    accessExpiresAt: '2026-08-18T12:00:00.000Z',
                  }
                : undefined,
          },
          clock: () => new Date('2026-08-17T12:30:00.000Z'),
        }),
      });
      apps.push(app);
      responses.push(
        await postRender(app, {
          ...(testCase.token === undefined ? {} : { viewerToken: testCase.token }),
          nonce,
        }),
      );
    }

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store, no-transform');
      expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
      expect(response.body).toContain('shelf:renderer-unavailable');
      expect(response.body).toContain(nonce);
      expect(response.body).not.toMatch(/private|actor|workspace|installation|secret/i);
    }
    expect(new Set(responses.map((response) => response.body))).toHaveLength(1);
  });

  it('returns a policy-bound safe document when the data plane is unavailable', async () => {
    const app = await createRendererApp({
      appOrigin,
      resolver: {
        async resolveHtml() {
          throw new Error('private database host and secret');
        },
      },
    });
    apps.push(app);

    const response = await postRender(app);

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.body).toContain('shelf:renderer-unavailable');
    expect(response.body).not.toMatch(/database|private|secret|stack|error/i);
  });
});

describe('folder sessions', () => {
  const host = 'render.example';
  const indexHtml =
    '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><a href="about.html">About</a><script type="module" src="js/app.js"></script></body></html>';
  const files = {
    'index.html': { mediaType: 'text/html', content: new TextEncoder().encode(indexHtml) },
    'docs/index.html': {
      mediaType: 'text/html',
      content: new TextEncoder().encode('<!doctype html><h1>Docs</h1>'),
    },
    'css/site.css': { mediaType: 'text/css', content: new TextEncoder().encode('body{}') },
    'js/app.js': {
      mediaType: 'text/javascript',
      content: new TextEncoder().encode('export const ready = true;'),
    },
    'img/a b.png': { mediaType: 'image/png', content: Uint8Array.from([1, 2, 3, 4, 5]) },
  };

  async function folderApp(share = rendererStoredShare()) {
    const app = await createRendererApp({
      appOrigin,
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
      resolver: createCoreHtmlResolver({
        appOrigin,
        ...rendererFolderDependencies(files, { share }),
        viewerSessionTokenCodec: {
          verify: (token) =>
            token === viewerToken
              ? {
                  shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
                  sessionId: '123e4567-e89b-42d3-a456-426614174000',
                  issuedAt: '2026-08-17T12:00:00.000Z',
                  accessExpiresAt: '2026-08-18T12:00:00.000Z',
                }
              : undefined,
        },
        clock: () => new Date('2026-08-17T12:30:00.000Z'),
      }),
    });
    apps.push(app);
    return app;
  }

  async function openSession(app: RendererApp, path = 'index.html', publicCode?: string) {
    const response = await postRender(app, {
      path,
      ...(publicCode === undefined ? {} : { publicCode }),
    });
    expect(response.statusCode).toBe(303);
    const location = String(response.headers.location);
    expect(location).toMatch(/^\/f\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\//u);
    return { location, sessionPath: location.slice(0, location.indexOf('/', 3) + 1) };
  }

  function get(
    app: RendererApp,
    url: string,
    headers: Record<string, string> = { 'sec-fetch-dest': 'script', origin: 'null' },
  ) {
    return app.inject({ method: 'GET', url, headers: { host, ...headers } });
  }

  it('redirects folder HTML into a hierarchical session URL and scopes its CSP to that path', async () => {
    const app = await folderApp();
    const { location, sessionPath } = await openSession(app);

    expect(location).toBe(`${sessionPath}index.html`);
    const response = await get(app, location, { 'sec-fetch-dest': 'iframe' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
    const policy = String(response.headers['content-security-policy']);
    const source = `https://${host}${sessionPath} http://${host}${sessionPath}`;
    expect(policy).toContain(`script-src 'unsafe-inline' data: ${source}`);
    expect(policy).toContain(`style-src 'unsafe-inline' ${source}`);
    expect(policy).toContain(`connect-src ${source}`);
    expect(policy).toContain(`font-src data: ${source}`);
    expect(policy).toContain(`frame-ancestors ${appOrigin}`);
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).not.toContain("'self'");
    expect(response.body).toContain('shelf:renderer-open-path');
    expect(response.body).toContain(JSON.stringify(sessionPath));
    expect(response.body).toContain('n'.repeat(22));
    expect(response.body.startsWith('<!doctype html><script>')).toBe(true);
    expect(response.body).toContain(indexHtml.slice('<!doctype html>'.length));
    expect(response.body).not.toContain(viewerToken);
  });

  it('serves sibling files with their media type, CORS for the opaque sandbox, and byte ranges', async () => {
    const app = await folderApp();
    const { sessionPath } = await openSession(app);

    const script = await get(app, `${sessionPath}js/app.js?v=2`);
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript');
    expect(script.headers['access-control-allow-origin']).toBe('*');
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(script.body).toBe('export const ready = true;');

    const image = await get(app, `${sessionPath}img/a%20b.png`, {
      'sec-fetch-dest': 'image',
      range: 'bytes=1-2',
    });
    expect(image.statusCode).toBe(206);
    expect(image.headers['content-range']).toBe('bytes 1-2/5');
    expect([...image.rawPayload]).toEqual([2, 3]);

    const unsatisfiable = await get(app, `${sessionPath}img/a%20b.png`, {
      'sec-fetch-dest': 'image',
      range: 'bytes=9-',
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe('bytes */5');

    const fetched = await get(app, `${sessionPath}index.html`, {
      'sec-fetch-dest': 'empty',
      origin: 'null',
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(fetched.body).toBe(indexHtml);
  });

  it('serves a directory link as its index document', async () => {
    const app = await folderApp();
    const { sessionPath } = await openSession(app);

    const response = await get(app, `${sessionPath}docs/`, { 'sec-fetch-dest': 'iframe' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h1>Docs</h1>');
  });

  it('rejects top-level opens, cookies, foreign origins, bad tokens, and escaping paths', async () => {
    const app = await folderApp();
    const { sessionPath } = await openSession(app);
    const token = sessionPath.slice(3, -1);
    const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;

    for (const [url, headers] of [
      [`${sessionPath}index.html`, { 'sec-fetch-dest': 'document' }],
      [`${sessionPath}js/app.js`, { 'sec-fetch-dest': 'script', cookie: 'session=1' }],
      [`${sessionPath}js/app.js`, { 'sec-fetch-dest': 'script', origin: 'https://evil.example' }],
      [`/f/${forged}/js/app.js`, { 'sec-fetch-dest': 'script' }],
      [`${sessionPath}..%2Fjs/app.js`, { 'sec-fetch-dest': 'script' }],
      [`${sessionPath}js%2Fapp.js`, { 'sec-fetch-dest': 'script' }],
      [`${sessionPath}missing.js`, { 'sec-fetch-dest': 'script' }],
    ] as const) {
      const response = await get(app, url, headers);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).toBe('');
    }

    const nonHtmlDocument = await get(app, `${sessionPath}js/app.js`, {
      'sec-fetch-dest': 'iframe',
    });
    expect(nonHtmlDocument.statusCode).toBe(404);
    expect(nonHtmlDocument.body).toContain('shelf:renderer-unavailable');
  });

  it('stops serving a session after the share is revoked', async () => {
    const share = rendererStoredShare();
    const app = await folderApp(share);
    const { sessionPath } = await openSession(app);
    share.revokedAt = '2026-08-17T12:20:00.000Z';

    const response = await get(app, `${sessionPath}js/app.js`);

    expect(response.statusCode).toBe(404);
  });

  it('points exact Public preview URLs from older folder HTML at the session', async () => {
    const publicCode = 'AbCdEf0123_-';
    const html = `<!doctype html><img src="${appOrigin}/api/v1/public/links/${publicCode}/tree/content/preview?path=img%2Fa%20b.png">`;
    files['index.html'].content = new TextEncoder().encode(html);
    try {
      const app = await folderApp(
        rendererStoredShare({ accessType: 'public', publicCode, sessionsUsed: 0 }),
      );
      const { sessionPath } = await openSession(app, 'index.html', publicCode);

      const response = await get(app, `${sessionPath}index.html`, { 'sec-fetch-dest': 'iframe' });

      expect(response.body).toContain(`src="${sessionPath}img/a%20b.png"`);
    } finally {
      files['index.html'].content = new TextEncoder().encode(indexHtml);
    }
  });
});
