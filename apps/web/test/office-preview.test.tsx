import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  DOCX_INTEGRATION,
  type DocxPage,
  DocxPageCanvas,
  DocxPreview,
  OfficePdfPreview,
} from '../src/components/preview/office-document-preview.js';

const page: DocxPage = {
  blocks: [
    {
      align: 'left',
      height: 34,
      kind: 'heading',
      level: 1,
      runs: [{ bold: true, text: 'Shelf release notes' }],
      width: 720,
      x: 48,
      y: 48,
    },
    {
      height: 54,
      kind: 'paragraph',
      runs: [{ text: 'A safe text model keeps document preview isolated.' }],
      width: 720,
      x: 48,
      y: 96,
    },
    {
      height: 100,
      kind: 'table',
      rows: [[{ runs: [{ text: 'Status' }] }], [{ runs: [{ text: 'Ready' }] }]],
      width: 720,
      x: 48,
      y: 170,
    },
  ],
  height: 1056,
  id: 'page-1',
  width: 816,
};

describe('DOCX adapter and preview contracts', () => {
  it('pins the recommended parser at a current source-backed version', () => {
    expect(DOCX_INTEGRATION.packageName).toBe('docx-preview');
    expect(DOCX_INTEGRATION.version).toBe('0.4.0');
    expect(DOCX_INTEGRATION.source).toContain('github.com/VolodymyrBaydalka/docxjs');
  });

  it('renders only inert text-model output with layout blocks and tables', () => {
    const html = renderToStaticMarkup(<DocxPageCanvas page={page} scale={1} />);

    expect(html).toContain('data-safe-output="text-model"');
    expect(html).toContain('Shelf release notes');
    expect(html).toContain('<table>');
    expect(html).toContain('Status');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('dangerouslySetInnerHTML');
    expect(html).not.toContain('<iframe');
  });

  it('exposes page navigation, fit, zoom, and adapter loading states', () => {
    const html = renderToStaticMarkup(
      <DocxPreview
        metadata={{
          fileName: 'release.docx',
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }}
        src={new ArrayBuffer(0)}
        title="Release document"
      />,
    );

    expect(html).toContain('aria-label="Previous DOCX page"');
    expect(html).toContain('aria-label="Next DOCX page"');
    expect(html).toContain('aria-label="Zoom in DOCX"');
    expect(html).toContain('aria-label="Fit DOCX page to width"');
    expect(html).toContain('Loading DOCX');
    expect(html).not.toContain('<iframe');
  });

  it('routes layout-heavy office formats through the existing PDF viewer', () => {
    const html = renderToStaticMarkup(
      <OfficePdfPreview
        formatLabel="PowerPoint layout preview"
        src="https://preview.example.test/deck.pdf"
        title="Deck preview"
      />,
    );

    expect(html).toContain('data-preview-kind="office-pdf"');
    expect(html).toContain('Rendered on the server as PDF');
    expect(html).toContain('aria-label="Previous PDF page"');
    expect(html).not.toContain('allow-scripts');
  });
});
