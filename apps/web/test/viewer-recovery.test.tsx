import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicShareUnavailableError } from '../src/api.js';
import { IncompleteShareLinkError } from '../src/capability.js';
import { recoverViewerOperation } from '../src/viewer-recovery.js';
import { ViewerRecoveryView } from '../src/viewer-recovery-view.js';
import { retryViewerRequest } from '../src/viewer-retry.js';

afterEach(() => vi.useRealTimers());

it('shows the existing loading view for a transient route failure', () => {
  const markup = renderToStaticMarkup(
    createElement(ViewerRecoveryView, {
      error: new PublicShareUnavailableError({ failure: 'transient' }),
      revalidate: async () => {},
      readFailure: () => undefined,
    }),
  );
  expect(markup).toContain('Opening artifact');
  expect(markup).not.toContain('This artifact is unavailable');
});

it.each([
  [new PublicShareUnavailableError({ failure: 'terminal' }), 'This artifact is unavailable'],
  [new IncompleteShareLinkError(), 'This protected link is incomplete'],
])('shows terminal and incomplete views immediately', (error, text) => {
  const markup = renderToStaticMarkup(
    createElement(ViewerRecoveryView, {
      error,
      revalidate: async () => {},
      readFailure: () => undefined,
    }),
  );
  expect(markup).toContain(text);
  expect(markup).not.toContain('Opening artifact');
});

it('backs off at 1, 2, 4, then 8 seconds and stops at 30 seconds', async () => {
  vi.useFakeTimers();
  const times: number[] = [];
  vi.setSystemTime(0);
  const operation = vi.fn(async () => {
    times.push(Date.now());
    throw new TypeError('offline');
  });
  const result = recoverViewerOperation(operation, new AbortController().signal);
  const assertion = expect(result).rejects.toThrow('offline');
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(times).toEqual([0, 1000, 3000, 7000, 15000, 23000]);
  expect(vi.getTimerCount()).toBe(0);
});

it('recovers a persistent failure after the in-call budget is spent', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const operation = vi.fn(async () => {
    if (Date.now() < 5_000) throw new TypeError('restart');
    return 'ready';
  });
  const result = recoverViewerOperation(
    () => retryViewerRequest(operation),
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(8_000);
  await expect(result).resolves.toBe('ready');
});

it('does not recover terminal failures and cancels pending recovery on navigation', async () => {
  vi.useFakeTimers();
  const terminal = vi.fn(async () => {
    throw new PublicShareUnavailableError({ failure: 'terminal' });
  });
  await expect(
    recoverViewerOperation(terminal, new AbortController().signal),
  ).rejects.toMatchObject({ failure: 'terminal' });
  expect(terminal).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const operation = vi.fn(async () => {
    throw new TypeError('offline');
  });
  const result = recoverViewerOperation(operation, controller.signal);
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await assertion;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
