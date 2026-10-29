import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CodeView, FileLoadingState } from '../src/components/file-view.js';
import { lazyModule } from '../src/components/lazy-module.js';

describe('lazy content modules', () => {
  it('renders a second mount synchronously after the module resolves', async () => {
    const View = ({ title }: { title: string }) => <h1>{title}</h1>;
    const load = vi.fn(async () => View);
    const Lazy = lazyModule(load, <p>Loading</p>);
    expect(renderToStaticMarkup(<Lazy title="First" />)).toBe('<p>Loading</p>');
    await Lazy.preload();
    expect(renderToStaticMarkup(<Lazy title="Second" />)).toBe('<h1>Second</h1>');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one pending import and caches its component', async () => {
    const load = vi.fn(async () => () => <p>Ready</p>);
    const Lazy = lazyModule(load, null);
    const first = Lazy.preload();
    const second = Lazy.preload();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await Lazy.preload();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('lets a later load retry after an import failure', async () => {
    const error = new Error('chunk unavailable');
    const load = vi
      .fn<() => Promise<() => React.JSX.Element>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(() => <p>Recovered</p>);
    const Lazy = lazyModule(load, <p>Loading</p>);
    await expect(Lazy.preload()).rejects.toBe(error);
    expect(renderToStaticMarkup(<Lazy />)).toBe('<p>Loading</p>');
    await Lazy.preload();
    expect(renderToStaticMarkup(<Lazy />)).toBe('<p>Recovered</p>');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the Pierre loading view without a Suspense retry boundary', () => {
    const html = renderToStaticMarkup(
      <CodeView label="Source preview" source="const ready = true;" fileName="ready.ts" />,
    );
    expect(html).toContain(renderToStaticMarkup(<FileLoadingState />));
    expect(html).not.toContain('<template');
  });
});
