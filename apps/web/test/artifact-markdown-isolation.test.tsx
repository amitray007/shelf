import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('../src/components/preview/pdf-preview.js', () => {
  throw new Error('Markdown must not import PDF');
});
vi.mock('../src/components/preview/office-document-preview.js', () => {
  throw new Error('Markdown must not import DOCX');
});
vi.mock('../src/components/preview/office-parser-bindings.js', () => {
  throw new Error('Markdown must not import Office parsers');
});
vi.mock('../src/components/preview/workbook-preview.js', () => {
  throw new Error('Markdown must not import workbooks');
});
vi.mock('../src/components/preview/delimited-table-preview.js', () => {
  throw new Error('Markdown must not import tables');
});
vi.mock('../src/components/preview/structured-data-preview.js', () => {
  throw new Error('Markdown must not import structured data');
});
vi.mock('../src/components/preview/media-preview.js', () => {
  throw new Error('Markdown must not import media');
});
vi.mock('../src/components/preview/image-preview.js', () => {
  throw new Error('Markdown must not import images');
});

it('renders Markdown while unrelated preview imports would throw', async () => {
  const { ArtifactFileView } = await import('../src/components/artifact-file-view.js');
  const { LazyMarkdownView } = await import('../src/components/lazy-views.js');
  await LazyMarkdownView.preload();
  const markup = renderToStaticMarkup(
    <ArtifactFileView
      content={{ status: 'ready', bytes: new TextEncoder().encode('# Only Markdown').buffer }}
      file={{ id: 'markdown', name: 'notes.md', mediaType: 'text/markdown' }}
    />,
  );
  expect(markup).toContain('<h1>Only Markdown</h1>');
  expect(markup).not.toContain('Opening artifact');
});
