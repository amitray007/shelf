import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactRetentionCleanupScheduler,
  createCommentAbuseCleanupScheduler,
} from '../src/server.js';

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

describe('artifact retention maintenance', () => {
  it('trashes due artifacts, purges expired Trash, and drains sealed content deletion', async () => {
    const trashDueArtifacts = vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    const purgeExpiredArtifacts = vi.fn().mockResolvedValueOnce(0);
    const listQueuedContentPurges = vi
      .fn()
      .mockResolvedValue([{ content_id: 'cnt_delete', artifact_id: 'art_deleted' }]);
    const completeContentPurge = vi.fn().mockResolvedValue(undefined);
    const failContentPurge = vi.fn().mockResolvedValue(undefined);
    const deleteSealed = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval;
    const cancel = vi.fn() as unknown as typeof clearInterval;
    const logger = { error: vi.fn() };
    const now = new Date('2026-08-22T00:00:00.000Z');
    const scheduler = createArtifactRetentionCleanupScheduler(
      {
        revisionRepository: {
          trashDueArtifacts,
          purgeExpiredArtifacts,
          listQueuedContentPurges,
          completeContentPurge,
          failContentPurge,
        },
        contentStore: { deleteSealed },
      } as never,
      logger as never,
      {
        batchSize: 2,
        now: () => now,
        setInterval: schedule,
        clearInterval: cancel,
      },
    );

    scheduler.start();
    await vi.waitFor(() => expect(completeContentPurge).toHaveBeenCalledWith('cnt_delete'));
    expect(trashDueArtifacts).toHaveBeenCalledTimes(2);
    expect(trashDueArtifacts).toHaveBeenCalledWith(now, 2);
    expect(purgeExpiredArtifacts).toHaveBeenCalledWith(now, 2);
    expect(listQueuedContentPurges).toHaveBeenCalledWith(10);
    expect(deleteSealed).toHaveBeenCalledWith('cnt_delete');
    expect(failContentPurge).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();

    await scheduler.stop();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps failed content deletion queued for a later retry', async () => {
    const failure = new Error('storage unavailable');
    const failContentPurge = vi.fn().mockResolvedValue(undefined);
    const logger = { error: vi.fn() };
    const now = new Date('2026-08-22T00:00:00.000Z');
    const scheduler = createArtifactRetentionCleanupScheduler(
      {
        revisionRepository: {
          trashDueArtifacts: vi.fn().mockResolvedValue(0),
          purgeExpiredArtifacts: vi.fn().mockResolvedValue(0),
          listQueuedContentPurges: vi
            .fn()
            .mockResolvedValue([{ content_id: 'cnt_retry', artifact_id: 'art_deleted' }]),
          completeContentPurge: vi.fn(),
          failContentPurge,
        },
        contentStore: { deleteSealed: vi.fn().mockRejectedValue(failure) },
      } as never,
      logger as never,
      { now: () => now, setInterval: vi.fn(() => 1) as never, clearInterval: vi.fn() as never },
    );

    scheduler.start();
    await vi.waitFor(() => expect(failContentPurge).toHaveBeenCalledWith('cnt_retry', now));
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, contentId: 'cnt_retry', artifactId: 'art_deleted' },
      'Shelf retained a failed content purge for retry.',
    );
    await scheduler.stop();
  });
});
