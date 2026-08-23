import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createPdfJsAdapter,
  PDF_JS_INTEGRATION,
  type PdfJsModule,
  PdfViewer,
} from '../src/components/preview/pdf-viewer.js';

describe('PDF.js adapter boundary', () => {
  it('passes URL sources through the range-friendly PDF.js document API', () => {
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 0, getPage: vi.fn() }),
    }));
    const adapter = createPdfJsAdapter({ getDocument } satisfies PdfJsModule);

    adapter.getDocument('https://cdn.example.test/report.pdf');

    expect(getDocument).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/report.pdf',
      disableAutoFetch: false,
      disableStream: false,
      rangeChunkSize: 65_536,
    });
    expect(PDF_JS_INTEGRATION.packageName).toBe('pdfjs-dist');
    expect(PDF_JS_INTEGRATION.version).toBe('6.2.108');
  });

  it('uses byte data without turning it into a URL', () => {
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 0, getPage: vi.fn() }),
    }));
    const adapter = createPdfJsAdapter({ getDocument } satisfies PdfJsModule);
    const bytes = new Uint8Array([37, 80, 68, 70]);

    adapter.getDocument(bytes, { rangeChunkSize: 32_768 });

    expect(getDocument).toHaveBeenCalledWith({
      data: bytes,
      disableAutoFetch: false,
      disableStream: false,
      rangeChunkSize: 32_768,
    });
  });
});

describe('PDF viewer semantics', () => {
  it('renders paginated, keyboard-oriented controls without an iframe', () => {
    const html = renderToStaticMarkup(
      <PdfViewer src="https://cdn.example.test/report.pdf" title="Design report" />,
    );

    expect(html).toContain('aria-label="Design report"');
    expect(html).toContain('aria-label="Previous PDF page"');
    expect(html).toContain('aria-label="Next PDF page"');
    expect(html).toContain('aria-label="Zoom out PDF"');
    expect(html).toContain('aria-label="Zoom in PDF"');
    expect(html).toContain('aria-label="Fit PDF page to width"');
    expect(html).toContain('aria-label="Current PDF page"');
    expect(html).toContain('canvas');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Use Page Up and Page Down');
  });
});
