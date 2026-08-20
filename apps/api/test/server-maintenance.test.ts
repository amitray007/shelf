import { describe, expect, it, vi } from 'vitest';

import { createCommentAbuseCleanupScheduler } from '../src/server.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('comment abuse metadata maintenance', () => {
  it('runs an initial bounded drain, continues in batches, and clears its timer', async () => {
    const cleanup = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const schedule = vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval;
    const cancel = vi.fn() as unknown as typeof clearInterval;
    const logger = { error: vi.fn() };
    const scheduler = createCommentAbuseCleanupScheduler(
      { cleanupExpiredAbuse: cleanup } as never,
      logger as never,
      { batchSize: 2, intervalMs: 60_000, setInterval: schedule, clearInterval: cancel },
    );

    scheduler.start();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    expect(schedule).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenNthCalledWith(1, expect.any(String), 2);
    expect(cleanup).toHaveBeenNthCalledWith(2, expect.any(String), 2);

    await scheduler.stop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not overlap drains and logs cleanup failures without throwing', async () => {
    const first = deferred<number>();
    const cleanup = vi.fn().mockReturnValueOnce(first.promise);
    let tick: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return { unref: vi.fn() };
    }) as unknown as typeof setInterval;
    const cancel = vi.fn() as unknown as typeof clearInterval;
    const logger = { error: vi.fn() };
    const scheduler = createCommentAbuseCleanupScheduler(
      { cleanupExpiredAbuse: cleanup } as never,
      logger as never,
      { setInterval: schedule, clearInterval: cancel },
    );

    scheduler.start();
    tick?.();
    expect(cleanup).toHaveBeenCalledOnce();
    first.resolve(0);
    await scheduler.stop();

    const failingCleanup = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const failureLogger = { error: vi.fn() };
    const failingScheduler = createCommentAbuseCleanupScheduler(
      { cleanupExpiredAbuse: failingCleanup } as never,
      failureLogger as never,
      { setInterval: schedule, clearInterval: cancel },
    );
    expect(() => failingScheduler.start()).not.toThrow();
    await vi.waitFor(() => expect(failureLogger.error).toHaveBeenCalledOnce());
    await failingScheduler.stop();
  });
});
