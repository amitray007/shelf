import { type ComponentType, type ReactNode, useEffect, useState } from 'react';

/** Load content without Suspense's fallback retry throttle. Call at module scope. */
export function lazyModule<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  fallback: ReactNode,
) {
  type Result = { readonly View: ComponentType<Props> } | { readonly error: unknown };
  let cached: Result | null = null;
  let pending: Promise<ComponentType<Props>> | undefined;

  function preload(): Promise<ComponentType<Props>> {
    if (cached !== null && 'View' in cached) return Promise.resolve(cached.View);
    pending ??= Promise.resolve()
      .then(load)
      .then(
        (View) => {
          cached = { View };
          pending = undefined;
          return View;
        },
        (error: unknown) => {
          // Keep the error local to the mounted caller. A later mount can retry.
          pending = undefined;
          throw error;
        },
      );
    return pending;
  }

  function LazyModule(props: Props) {
    const [result, setResult] = useState<Result | null>(() => cached);
    useEffect(() => {
      if (result !== null) return;
      let active = true;
      void preload().then(
        (View) => {
          if (active) setResult({ View });
        },
        (error: unknown) => {
          if (active) setResult({ error });
        },
      );
      return () => {
        active = false;
      };
    }, [result]);
    if (result === null) return fallback;
    if ('error' in result) throw result.error;
    return <result.View {...props} />;
  }

  return Object.assign(LazyModule, { preload });
}
