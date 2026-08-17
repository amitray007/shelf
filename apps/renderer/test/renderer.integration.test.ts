import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRendererApp, type RendererApp } from '../src/app.js';
import { createCoreHtmlResolver } from '../src/resolver.js';
import { rendererDependencies, rendererStoredShare } from './support/renderer-dependencies.js';

const apps: RendererApp[] = [];
const appOrigin = 'https://shelf.example';

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
  values: { shareId?: string; secret?: string; nonce?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/render',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: appOrigin,
    },
    payload: new URLSearchParams({
      shareId: values.shareId ?? 'shr_AAAAAAAAAAAAAAAAAAAAAA',
      secret: values.secret ?? 's'.repeat(43),
      nonce: values.nonce ?? 'n'.repeat(22),
    }).toString(),
  });
}

describe('isolated HTML renderer', () => {
  it('serves an inert availability document with no active bootstrap permissions', async () => {
    const app = await fixture();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['content-security-policy']).toContain("navigate-to 'none'");
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
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
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
    const secret = 's'.repeat(43);
    const nonce = 'n'.repeat(22);

    const response = await app.inject({
      method: 'POST',
      url: '/render',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: appOrigin,
      },
      payload: new URLSearchParams({
        shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
        secret,
        nonce,
      }).toString(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['permissions-policy']).toContain('geolocation=()');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['content-security-policy']).toContain("navigate-to 'none'");
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
    expect(response.body).not.toContain(secret);
    expect(response.body.indexOf('shelf:renderer-ready')).toBeLessThan(
      response.body.indexOf('collector.invalid'),
    );
    expect(resolveHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
        secret,
        signal: expect.any(AbortSignal),
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

  it('accepts capabilities only from the exact parent-origin form body', async () => {
    const resolveHtml = vi.fn(async () => ({
      status: 'available' as const,
      html: '<!doctype html><title>Artifact</title>',
    }));
    const app = await createRendererApp({ appOrigin, resolver: { resolveHtml } });
    apps.push(app);
    const nonce = 'n'.repeat(22);
    const secretCanary = 's'.repeat(43);
    const validBody = new URLSearchParams({
      shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
      secret: secretCanary,
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
        payload: `${validBody}&secret=${secretCanary}`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: appOrigin,
        },
        payload: `${validBody}&unexpected=value`,
        url: '/render',
      },
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: appOrigin,
        },
        payload: validBody,
        url: `/render?secret=${secretCanary}`,
      },
    ];

    for (const request of invalidRequests) {
      const response = await app.inject({ method: 'POST', ...request });
      expect(response.statusCode).toBe(404);
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).toContain('shelf:renderer-unavailable');
      expect(response.body).not.toContain(secretCanary);
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
        origin: appOrigin,
      },
      payload: `nonce=${'n'.repeat(22)}&padding=${'x'.repeat(3_000)}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.body).toContain('shelf:renderer-unavailable');
    expect(response.body).not.toMatch(/payload|too large|error|stack/i);
  });

  it('makes wrong, malformed, revoked, and expired capabilities indistinguishable', async () => {
    const nonce = 'n'.repeat(22);
    const cases = [
      { dependencies: rendererDependencies(), secret: 'w'.repeat(43) },
      { dependencies: rendererDependencies(), secret: 'malformed' },
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
          ...testCase.dependencies,
          capabilityCodec: {
            deriveSecret: () => 's'.repeat(43),
            validateSecret: (_shareId, supplied) => supplied === 's'.repeat(43),
          },
          clock: () => new Date('2026-08-17T12:30:00.000Z'),
        }),
      });
      apps.push(app);
      responses.push(await postRender(app, { secret: testCase.secret, nonce }));
    }

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
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
