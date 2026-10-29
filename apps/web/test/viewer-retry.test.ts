import { afterEach, expect, it, vi } from 'vitest';
import { establishProtectedSession } from '../src/api.js';
import { consumeViewerRecovery, retryViewerRequest } from '../src/viewer-retry.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  consumeViewerRecovery();
});

it('leaves the healthy path at one immediate attempt', async () => {
  const operation = vi.fn(async () => 'ok');
  await expect(retryViewerRequest(operation)).resolves.toBe('ok');
  expect(operation).toHaveBeenCalledTimes(1);
});
it('recovers network errors and bounds persistent failure', async () => {
  vi.useFakeTimers();
  const operation = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue('ok');
  const result = retryViewerRequest(operation);
  await vi.advanceTimersByTimeAsync(121);
  await expect(result).resolves.toBe('ok');
  const failed = retryViewerRequest(async () => {
    throw new TypeError('offline');
  });
  const assertion = expect(failed).rejects.toThrow('offline');
  await vi.advanceTimersByTimeAsync(2501);
  await assertion;
  expect(consumeViewerRecovery()).toBe(true);
});
it('stops immediately on navigation cancellation during backoff', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const operation = vi.fn(async () => {
    throw new TypeError('network');
  });
  const result = retryViewerRequest(operation, controller.signal);
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await assertion;
  await vi.advanceTimersByTimeAsync(9000);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(consumeViewerRecovery()).toBe(false);
});
it.each([
  [503, false],
  [404, undefined],
  [429, false],
])('does not retry terminal HTTP %s with retryable %s', async (status, retryable) => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ error: { retryable } }), { status }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    establishProtectedSession('share', 'session', { token: 'token' }),
  ).rejects.toMatchObject({ failure: 'terminal' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('retries a retryable envelope on the session exchange', async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { retryable: true } }), { status: 503 }),
    )
    .mockResolvedValue(
      new Response(JSON.stringify({ error: { retryable: false } }), { status: 403 }),
    );
  vi.stubGlobal('fetch', fetcher);
  const result = establishProtectedSession('share', 'session', { secret: 'secret' });
  const assertion = expect(result).rejects.toMatchObject({ failure: 'terminal' });
  await vi.advanceTimersByTimeAsync(121);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('retries an abort that does not come from the navigation signal', async () => {
  vi.useFakeTimers();
  const operation = vi
    .fn()
    .mockRejectedValueOnce(new DOMException('reset', 'AbortError'))
    .mockResolvedValue('recovered');
  const result = retryViewerRequest(operation, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(121);
  await expect(result).resolves.toBe('recovered');
});

it('retries public config when reading the body loses the connection', async () => {
  vi.useFakeTimers();
  const { clearViewerCaches, prepareViewerRendererConfig } = await import('../src/api.js');
  clearViewerCaches();
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError('reset'));
      },
    }),
  );
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(broken)
    .mockResolvedValue(Response.json({ apiVersion: 'v1', rendererOrigin: null }));
  vi.stubGlobal('fetch', fetcher);
  const consumeConfig = prepareViewerRendererConfig(undefined, true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const result = consumeConfig();
  await vi.advanceTimersByTimeAsync(121);
  await expect(result).resolves.toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(2);
  clearViewerCaches();
});

it('lets an in-flight successful attempt finish after the retry budget', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const operation = vi.fn(
    (signal: AbortSignal | undefined) =>
      new Promise<string>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => resolve('complete'), 12_000);
      }),
  );
  const result = retryViewerRequest(operation, controller.signal);
  await vi.advanceTimersByTimeAsync(12_001);
  await expect(result).resolves.toBe('complete');
  expect(operation).toHaveBeenCalledTimes(1);
  expect(controller.signal.aborted).toBe(false);
});

it.each([408, 425, 429, 499])('retries transient HTTP %s', async (status) => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status }))
    .mockResolvedValue(new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const result = establishProtectedSession('share', 'session', { token: 'token' });
  const assertion = expect(result).rejects.toMatchObject({ failure: 'terminal' });
  await vi.advanceTimersByTimeAsync(121);
  await assertion;
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('does not schedule another attempt when an in-flight failure exceeds the budget', async () => {
  vi.useFakeTimers();
  const operation = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new TypeError('reset')), 9_000);
      }),
  );
  const result = retryViewerRequest(operation);
  const assertion = expect(result).rejects.toThrow('reset');
  await vi.advanceTimersByTimeAsync(9_001);
  await assertion;
  expect(operation).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('rides out a 1.5 second restart inside the short request budget', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const result = retryViewerRequest(async () => {
    if (Date.now() < 1500) throw new TypeError('restarting');
    return 'ready';
  });
  await vi.advanceTimersByTimeAsync(2501);
  await expect(result).resolves.toBe('ready');
});
