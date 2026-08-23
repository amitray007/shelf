import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  prefersSourceView,
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
vi.mock('../src/components/preview/structured-data-preview.js', () => {
  prefetchedModules.push('structured-data-preview');
  return { StructuredDataPreview: () => null };
});
vi.mock('../src/components/preview/delimited-table-preview.js', () => {
  prefetchedModules.push('delimited-table-preview');
  return { DelimitedTablePreview: () => null };
});
vi.mock('../src/components/preview/pdf-viewer.js', () => {
  prefetchedModules.push('pdf-viewer');
  return { PdfViewer: () => null };
});
vi.mock('../src/components/preview/media-preview.js', () => {
  prefetchedModules.push('media-preview');
  return { AudioPreview: () => null, VideoPreview: () => null };
});
vi.mock('../src/components/preview/office-document-preview.js', () => {
  prefetchedModules.push('office-document-preview');
  return { DocxPreview: () => null };
});
vi.mock('../src/components/preview/workbook-preview.js', () => {
  prefetchedModules.push('workbook-preview');
  return { WorkbookPreview: () => null };
});
vi.mock('../src/components/preview/office-parser-bindings.js', () => {
  prefetchedModules.push('office-parser-bindings');
  return {};
});

describe('passive renderer selection', () => {
  it.each([
    ['text/plain', 'text'],
    ['text/x-python', 'text'],
    ['application/javascript', 'text'],
    ['application/json', 'json'],
    ['application/problem+json', 'json'],
    ['text/markdown', 'markdown'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'workbook'],
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/gif', 'image'],
    ['image/webp', 'image'],
    ['image/avif', 'image'],
    ['image/bmp', 'image'],
    ['image/apng', 'image'],
  ] as const)('selects %s as %s', (mediaType, expected) => {
    expect(selectRenderer(mediaType, undefined)).toEqual({ kind: expected });
  });

  it.each([
    ['image/svg+xml', 'image'],
    ['application/pdf', 'pdf'],
    ['video/mp4', 'video'],
  ] as const)('selects %s as %s', (mediaType, expected) => {
    expect(selectRenderer(mediaType, 'https://renderer.example')).toEqual({ kind: expected });
  });

  it('keeps unknown generic content download-only', () => {
    expect(selectRenderer('application/octet-stream', 'https://renderer.example')).toEqual({
      kind: 'download',
    });
  });

  it('uses a generic upload extension as a conservative secondary signal', () => {
    expect(selectRenderer('application/octet-stream', undefined, 'report.PDF')).toEqual({
      kind: 'pdf',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'data.csv')).toEqual({
      kind: 'table',
      format: 'csv',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'events.jsonl')).toEqual({
      kind: 'text',
    });
    expect(selectRenderer('application/octet-stream', undefined, '.env.production')).toEqual({
      kind: 'text',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'Dockerfile')).toEqual({
      kind: 'text',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'template.html')).toEqual({
      kind: 'download',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'release.docx')).toEqual({
      kind: 'docx',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'budget.xlsx')).toEqual({
      kind: 'workbook',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'legacy.xls')).toEqual({
      kind: 'download',
    });
    expect(selectRenderer('application/octet-stream', undefined, 'deck.pptx')).toEqual({
      kind: 'download',
    });
  });

  it('keeps declared MIME types authoritative over a conflicting extension', () => {
    expect(selectRenderer('text/plain', undefined, 'report.pdf')).toEqual({ kind: 'text' });
  });

  it.each(['application/x-ndjson', 'application/jsonl'])(
    'keeps %s as inert source text',
    (mediaType) => {
      expect(selectRenderer(mediaType, undefined, 'events.jsonl')).toEqual({ kind: 'text' });
      expect(supportsSourceView(mediaType, 'events.jsonl')).toBe(true);
    },
  );

  it('opens code and JSON Lines in source while keeping prose and structured data in preview', () => {
    expect(prefersSourceView('text/x-typescript', 'src/telemetry.ts')).toBe(true);
    expect(prefersSourceView('text/x-python', 'tools/check.py')).toBe(true);
    expect(prefersSourceView('application/jsonl', 'events.jsonl')).toBe(true);
    expect(prefersSourceView('text/plain', 'notes.txt')).toBe(false);
    expect(prefersSourceView('application/json', 'config.json')).toBe(false);
    expect(prefersSourceView('application/yaml', 'config.yml')).toBe(false);
  });

  it.each(['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'])(
    'selects %s as structured data',
    (mediaType) => {
      expect(selectRenderer(mediaType, undefined)).toEqual({ kind: 'json' });
    },
  );

  it('never executes SVG markup through the HTML renderer', () => {
    expect(selectRenderer('image/svg+xml', 'https://renderer.example')).toEqual({ kind: 'image' });
  });

  it('does not use an invalid renderer origin for HTML', () => {
    expect(selectRenderer('text/html', 'https://renderer.example/render')).toEqual({
      kind: 'download',
    });
  });

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

  it.each(['text/plain', 'image/png', 'text/html'])('%s prefetches nothing', async (mediaType) => {
    expect(await prefetch({ kind: 'file', mediaType })).toEqual([]);
  });

  it('prefetches structured and media chunks for their renderers', async () => {
    expect(await prefetch({ kind: 'file', mediaType: 'application/json' })).toContain(
      'structured-data-preview',
    );
    expect(await prefetch({ kind: 'file', mediaType: 'application/pdf' })).toContain('pdf-viewer');
    expect(await prefetch({ kind: 'file', mediaType: 'video/mp4' })).toContain('media-preview');
  });

  it('prefetches the office viewer chunks for direct-preview formats', async () => {
    expect(
      await prefetch({
        kind: 'file',
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toEqual(expect.arrayContaining(['office-document-preview', 'office-parser-bindings']));
    prefetchedModules.length = 0;
    expect(
      await prefetch({
        kind: 'file',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toEqual(expect.arrayContaining(['workbook-preview']));
  });

  it('prefetches nothing for an unsupported media type', async () => {
    expect(await prefetch({ kind: 'file', mediaType: 'application/octet-stream' })).toEqual([]);
  });

  it('prefetches nothing for a file revision without a known media type', async () => {
    expect(await prefetch({ kind: 'file' })).toEqual([]);
  });
});
