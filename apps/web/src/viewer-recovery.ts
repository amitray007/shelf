import { isTransientViewerFailure } from './viewer-retry.js';

/** One recovery window per load, shared by route, file, and folder recovery. */
export class ViewerRecoverySchedule {
  private deadline: number | undefined;
  private delay = 1_000;

  nextDelay(error: unknown): number | undefined {
    if (!isTransientViewerFailure(error)) return undefined;
    this.deadline ??= Date.now() + 30_000;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) return undefined;
    const delay = Math.min(this.delay, remaining);
    this.delay = Math.min(this.delay * 2, 8_000);
    return delay;
  }

  expired(): boolean {
    return this.deadline !== undefined && Date.now() >= this.deadline;
  }
}

export async function recoverViewerOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const schedule = new ViewerRecoverySchedule();
  for (;;) {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      const delay = schedule.nextDelay(error);
      if (delay === undefined) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        }, delay);
        signal.addEventListener('abort', abort, { once: true });
      });
      signal.throwIfAborted();
      if (schedule.expired()) throw error;
    }
  }
}
