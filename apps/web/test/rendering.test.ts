import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type prefetchRendererModules,
  selectRenderer,
  supportsSourceView,
} from '../src/rendering.js';

// The lazy renderer chunks pull in React and heavy view code, so the prefetch tests observe the
// dynamic imports through stubs rather than loading the real modules.
const prefetchedModules: string[] = [];
vi.mock('../src/components/folder-browser.js', () => {
  prefetchedModules.push('folder-browser');
  return { FolderBrowser: () => null };
});
vi.mock('../src/components/markdown-view.js', () => {
  prefetchedModules.push('markdown-view');
  return { MarkdownView: () => null };
});

describe('passive renderer selection', () => {
  it.each([
    ['text/plain', 'text'],
    ['text/x-python', 'text'],
    ['application/javascript', 'text'],
    ['application/json', 'json'],
    ['application/problem+json', 'json'],
    ['text/markdown', 'markdown'],
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/gif', 'image'],
    ['image/webp', 'image'],
    ['image/avif', 'image'],
  ] as const)('selects %s as %s', (mediaType, expected) => {
    expect(selectRenderer(mediaType, undefined)).toEqual({ kind: expected });
  });

  it.each(['image/svg+xml', 'application/pdf', 'application/octet-stream', 'video/mp4'])(
    'keeps %s download-only',
    (mediaType) => {
      expect(selectRenderer(mediaType, 'https://renderer.example')).toEqual({ kind: 'download' });
    },
  );

  it('allows HTML only through a validated isolated renderer origin', () => {
    expect(selectRenderer('text/html', undefined)).toEqual({ kind: 'download' });
    expect(selectRenderer('text/html', 'https://renderer.example')).toEqual({
      kind: 'html',
      url: 'https://renderer.example/render',
    });
    expect(selectRenderer('text/html', 'https://renderer.example/render')).toEqual({
      kind: 'download',
    });
  });

  it.each([
    ['text/markdown', true],
    ['text/html', true],
    ['application/json', true],
    ['image/svg+xml', true],
    ['image/png', false],
    ['image/jpeg', false],
    ['application/pdf', false],
  ] as const)('reports whether %s has a readable source view', (mediaType, expected) => {
    expect(supportsSourceView(mediaType)).toBe(expected);
  });
});

describe('renderer module prefetching', () => {
  beforeEach(() => {
    vi.resetModules();
    prefetchedModules.length = 0;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function prefetch(revision: Parameters<typeof prefetchRendererModules>[0]) {
    const rendering = await import('../src/rendering.js');
    rendering.prefetchRendererModules(revision);
    // The prefetch fires a floating dynamic import, so let the module graph settle first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return prefetchedModules;
  }

  it('warms the folder browser chunk for folder revisions', async () => {
    expect(await prefetch({ kind: 'folder' })).toEqual(['folder-browser']);
  });

  it('warms the markdown chunk for markdown revisions', async () => {
    expect(await prefetch({ kind: 'file', mediaType: 'text/markdown' })).toEqual(['markdown-view']);
  });

  it.each(['text/plain', 'application/json', 'image/png', 'text/html', 'application/pdf'])(
    'prefetches nothing for %s',
    async (mediaType) => {
      expect(await prefetch({ kind: 'file', mediaType })).toEqual([]);
    },
  );

  it('prefetches nothing for a file revision without a known media type', async () => {
    expect(await prefetch({ kind: 'file' })).toEqual([]);
  });
});
