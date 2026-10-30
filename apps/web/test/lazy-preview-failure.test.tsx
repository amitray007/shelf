import type { EffectCallback } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  effect: undefined as EffectCallback | undefined,
  result: null as unknown,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: EffectCallback) => {
    hooks.effect = effect;
  },
  useState: () => [
    hooks.result,
    (result: unknown) => {
      hooks.result = result;
    },
  ],
}));
vi.mock('../src/components/preview/image-preview.js', () => {
  throw new Error('Preview chunk unavailable');
});

it('surfaces a rejected chunk through the existing unavailable UI', async () => {
  const { prefetchRendererModules } = await import('../src/rendering.js');
  // A failed speculative import must not become an unhandled rejection.
  prefetchRendererModules({ kind: 'file', mediaType: 'image/png' });
  const { ImagePreview } = await import('../src/components/lazy-file-previews.js');
  const props = { alt: 'Preview', src: '/preview' };
  // Drive the hook lifecycle without a DOM. The first render keeps the loading view.
  expect(renderToStaticMarkup(ImagePreview(props))).toContain('Opening artifact');
  const cleanup = hooks.effect?.();
  await vi.waitFor(() => expect(hooks.result).toHaveProperty('error'));
  let failure: unknown;
  try {
    ImagePreview(props);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toBe((hooks.result as { error: unknown }).error);
  if (typeof cleanup === 'function') cleanup();

  // ViewerErrorBoundary sends render failures to this existing recovery component.
  hooks.result = false;
  const { ViewerRecoveryView } = await import('../src/viewer-recovery-view.js');
  const markup = renderToStaticMarkup(
    <ViewerRecoveryView
      error={failure}
      recoverable={false}
      revalidate={async () => {}}
      readFailure={() => failure}
    />,
  );
  expect(markup).toContain('This artifact is unavailable');
  expect(markup).not.toContain('Opening artifact');
});
