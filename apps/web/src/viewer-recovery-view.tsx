import { useEffect, useState } from 'react';
import { IncompleteShareLinkError } from './capability.js';
import { LoadingView, UnavailableView } from './components/boot-views.js';
import { recoverViewerOperation } from './viewer-recovery.js';
import { isTransientViewerFailure } from './viewer-retry.js';

export function ViewerRecoveryView({
  error,
  revalidate,
  readFailure,
  recoverable = true,
}: {
  readonly error: unknown;
  readonly revalidate: () => Promise<void>;
  readonly readFailure: () => unknown;
  /** False for render faults: revalidating would remount the same failing view in a loop. */
  readonly recoverable?: boolean;
}) {
  const transient = recoverable && isTransientViewerFailure(error);
  const [recovering, setRecovering] = useState(transient);
  const [cycle, setCycle] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revalidation changes error; one recovery window spans those changes.
  useEffect(() => {
    if (!transient) return;
    const controller = new AbortController();
    let first = true;
    setRecovering(true);
    void recoverViewerOperation(async () => {
      if (first) {
        first = false;
        throw error;
      }
      await revalidate();
      const failure = readFailure();
      if (failure !== undefined) throw failure;
    }, controller.signal).catch(() => {
      if (!controller.signal.aborted) setRecovering(false);
    });
    return () => controller.abort();
  }, [cycle]);
  useEffect(() => {
    const recover = () => {
      if (transient && !recovering) setCycle((value) => value + 1);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [transient, recovering]);
  if (transient && recovering) return <LoadingView />;
  return <UnavailableView incompleteLink={error instanceof IncompleteShareLinkError} />;
}
