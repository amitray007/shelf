import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const imported: string[] = [];
const modules = [
  ['image-preview', 'image', 'ImagePreview'],
  ['structured-data-preview', 'json', 'StructuredDataPreview'],
  ['delimited-table-preview', 'table', 'DelimitedTablePreview'],
  ['office-document-preview', 'docx', 'DocxPreview'],
  ['workbook-preview', 'workbook', 'WorkbookPreview'],
  ['pdf-preview', 'pdf', 'PdfPreview'],
  ['media-preview', 'media', 'AudioPreview'],
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const [path, marker, name] of modules) {
    vi.doMock(`../src/components/preview/${path}.js`, () => {
      imported.push(marker);
      return { [name]: () => null, VideoPreview: () => null };
    });
  }
  vi.doMock('../src/components/markdown-view.js', () => {
    imported.push('markdown');
    return { MarkdownView: () => null, MarkdownProperties: () => null };
  });
  vi.doMock('../src/components/folder-browser.js', async () => {
    await import('../src/components/artifact-file-view.js');
    imported.push('folder');
    return { FolderBrowser: () => null };
  });
});

afterEach(() => {
  for (const [path] of modules) vi.doUnmock(`../src/components/preview/${path}.js`);
  vi.doUnmock('../src/components/folder-browser.js');
  vi.doUnmock('../src/components/markdown-view.js');
  imported.length = 0;
});

describe('resolved renderer prefetch isolation', () => {
  it.each([
    ['notes.md', 'markdown'],
    ['image.png', 'image'],
    ['config.json', 'json'],
    ['table.csv', 'table'],
    ['table.tsv', 'table'],
    // The shared Office parser bindings also bring in the workbook preview.
    ['document.docx', ['docx', 'workbook']],
    ['book.xlsx', 'workbook'],
    ['document.pdf', 'pdf'],
    ['audio.mp3', 'media'],
    ['video.mp4', 'media'],
  ])('warms only the renderer for %s', async (name, module) => {
    const { prefetchRendererModules } = await import('../src/rendering.js');
    prefetchRendererModules({
      kind: 'file',
      mediaType: 'application/octet-stream',
      originalFileName: name,
    });
    const expected = Array.isArray(module) ? module : [module];
    await vi.waitFor(() => expect([...imported].sort()).toEqual([...expected].sort()));
  });

  it('loads a folder browser without loading any file preview', async () => {
    const { prefetchRendererModules } = await import('../src/rendering.js');
    prefetchRendererModules({ kind: 'folder' });
    await vi.waitFor(() => expect(imported).toEqual(['folder']), { timeout: 5000 });
  });
});
