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
  const secret = 's'.repeat(43);
  const ready = vi.fn(async () => undefined);
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
    },
    {
      ...dependencies,
      shares: dependencies.shares,
      capabilityCodec: {
        deriveSecret: () => secret,
        validateSecret: (_shareId, supplied) => supplied === secret,
      },
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
      ready,
      close,
    },
  );
  try {
    const address = await runtime.start();
    const response = await fetch(new URL('/render', address), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:5173',
      },
      body: new URLSearchParams({
        shareId: rendererIds.share,
        secret,
        nonce: 'n'.repeat(22),
      }),
    });

    expect(ready).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<h1>Artifact</h1>');
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
