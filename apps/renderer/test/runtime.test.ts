import { expect, it, vi } from 'vitest';

import { createRendererRuntime, type RendererRuntime } from '../src/runtime.js';
import { rendererDependencies, rendererIds } from './support/renderer-dependencies.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve?.() };
}

it('composes the existing share data plane into an independently managed renderer process', async () => {
  const viewerToken = `${'v'.repeat(24)}.${'s'.repeat(43)}`;
  const ready = vi.fn(async () => undefined);
  let currentOrigins = ['https://cdn.example'];
  let runtime: RendererRuntime;
  const close = vi.fn(async () => {
    expect(runtime.app.server.listening).toBe(false);
  });
  const dependencies = rendererDependencies();
  runtime = await createRendererRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      appOrigin: 'http://127.0.0.1:5173',
      maxHtmlBytes: 1024,
      trustedResourceOrigins: ['https://cdn.example'],
    },
    {
      ...dependencies,
      shares: dependencies.shares,
      viewerSessionTokenCodec: {
        verify: (token) =>
          token === viewerToken
            ? {
                shareId: rendererIds.share,
                sessionId: rendererIds.sessionId,
                issuedAt: '2026-08-17T12:00:00.000Z',
                accessExpiresAt: '2026-08-18T12:00:00.000Z',
              }
            : undefined,
      },
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
      ready,
      readTrustedResourceOrigins: async () => currentOrigins,
      close,
    },
  );
  try {
    const address = await runtime.start();
    const response = await fetch(new URL('/render', address), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
      },
      body: new URLSearchParams({
        shareId: rendererIds.share,
        viewerToken,
        nonce: 'n'.repeat(22),
      }),
    });

    expect(ready).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'unsafe-inline' data: https://cdn.example",
    );
    expect(await response.text()).toContain('<h1>Artifact</h1>');
    currentOrigins = [];
    const reloaded = await runtime.app.inject({
      method: 'POST',
      url: '/render',
      headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        shareId: rendererIds.share,
        viewerToken,
        nonce: 'n'.repeat(22),
      }).toString(),
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.headers['content-security-policy']).not.toContain('https://cdn.example');
  } finally {
    await runtime.close();
  }
  expect(close).toHaveBeenCalledOnce();
});

it('cannot reopen the listener when shutdown begins during dependency startup', async () => {
  const readiness = deferred();
  const closeDataPlane = vi.fn(async () => undefined);
  const dependencies = rendererDependencies();
  const runtime = await createRendererRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      appOrigin: 'http://127.0.0.1:5173',
      maxHtmlBytes: 1024,
    },
    {
      ...dependencies,
      viewerSessionTokenCodec: { verify: () => undefined },
      ready: () => readiness.promise,
      close: closeDataPlane,
    },
  );

  const startup = runtime.start();
  const shutdown = runtime.close();
  readiness.resolve();

  await expect(startup).rejects.toThrow('closed');
  await expect(shutdown).resolves.toBeUndefined();
  expect(runtime.app.server.listening).toBe(false);
  expect(closeDataPlane).toHaveBeenCalledOnce();
  await expect(runtime.start()).rejects.toThrow('closed');
});
