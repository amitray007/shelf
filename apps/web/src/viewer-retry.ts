/** Retry only read/session operations. Callers retain their original authority and signal. */
export function isTransientViewerFailure(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'failure' in error) {
    return error.failure === 'transient';
  }
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}

let recoveryNeeded = false;
export function consumeViewerRecovery(): boolean {
  const needed = recoveryNeeded;
  recoveryNeeded = false;
  return needed;
}

export async function retryViewerRequest<T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + 2_500;
  let delay = 100;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await operation(signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTransientViewerFailure(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        recoveryNeeded = true;
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          Math.min(remaining, delay * (0.8 + Math.random() * 0.4)),
        );
        signal?.addEventListener('abort', abort, { once: true });
      });
      if (Date.now() >= deadline) {
        recoveryNeeded = true;
        throw error;
      }
      delay = Math.min(delay * 2, 800);
    }
  }
}
