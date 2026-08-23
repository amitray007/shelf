import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createDocxPreviewAdapter,
  createWorkbookPreviewAdapter,
  DOCX_ADAPTER_INTEGRATION,
  type DocxPreviewModule,
  WORKBOOK_ADAPTER_INTEGRATION,
  type WorkbookParserModule,
} from '../src/components/preview/office-adapters.js';
import { loadWorkbookPreviewAdapter } from '../src/components/preview/office-parser-bindings.js';
import { WorkbookSheetGrid } from '../src/components/preview/workbook-preview.js';

const TINY_XLSX_BASE64 =
  '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';

function tinyXlsxFixture(): ArrayBuffer {
  const binary = atob(TINY_XLSX_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

class FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly nodeType: number;
  readonly ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;

  constructor(ownerDocument: FakeDocument, nodeType: number) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }
}

class FakeText extends FakeNode {
  readonly nodeValue: string;

  constructor(ownerDocument: FakeDocument, value: string) {
    super(ownerDocument, 3);
    this.nodeValue = value;
  }

  override get textContent(): string {
    return this.nodeValue;
  }
}

class FakeStyle {
  private readonly values = new Map<string, string>();

  setProperty(property: string, value: string): void {
    this.values.set(property, value);
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly tagName: string;

  constructor(ownerDocument: FakeDocument, tagName: string) {
    super(ownerDocument, 1);
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child): child is FakeElement => child.nodeType === 1);
  }

  get classList(): { contains: (value: string) => boolean } {
    return {
      contains: (value) => (this.getAttribute('class') ?? '').split(/\s+/u).includes(value),
    };
  }

  get innerHTML(): string {
    return '';
  }

  set innerHTML(_value: string) {
    this.childNodes.length = 0;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  createComment(value: string): FakeText {
    return new FakeText(this, `<!--${value}-->`);
  }

  createDocumentFragment(): FakeNode {
    return new FakeNode(this, 11);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
  }

  createTextNode(value: string): FakeText {
    return new FakeText(this, value);
  }

  importNode(node: Node): Node {
    return node;
  }
}

function appendText(document: FakeDocument, parent: FakeElement, value: string): void {
  parent.appendChild(document.createTextNode(value));
}

function makeDocxModule(document: FakeDocument): DocxPreviewModule {
  return {
    renderAsync: vi.fn(async (_source, body, _styles, options) => {
      const detachedBody = body as unknown as FakeElement;
      const hook = options?.h as ((value: unknown) => FakeNode) | undefined;
      if (hook !== undefined)
        detachedBody.appendChild(hook({ tagName: 'span', children: ['hook text'] }));

      const page = document.createElement('section');
      page.setAttribute('class', 'docx');
      page.setAttribute('style', 'width: 816px; height: 1056px');
      const paragraph = document.createElement('p');
      paragraph.setAttribute('style', 'left: 48px; top: 48px; width: 720px; height: 28px');
      appendText(document, paragraph, 'Visible ');
      const link = document.createElement('a');
      link.setAttribute('href', 'javascript:alert(1)');
      appendText(document, link, 'linked text');
      paragraph.appendChild(link);
      page.appendChild(paragraph);

      const script = document.createElement('script');
      appendText(document, script, 'do not render');
      page.appendChild(script);

      const table = document.createElement('table');
      table.setAttribute('style', 'left: 48px; top: 100px; width: 720px; height: 60px');
      for (const value of ['A', 'B']) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        appendText(document, cell, value);
        row.appendChild(cell);
        table.appendChild(row);
      }
      page.appendChild(table);
      detachedBody.appendChild(page);
    }),
  };
}

describe('office adapter factories', () => {
  it('resolves the pinned DOCX package binding at its real browser entrypoint', async () => {
    const module = (await import('docx-preview')) as Partial<DocxPreviewModule>;
    expect(typeof module.renderAsync).toBe('function');
  });

  it('records the verified integration boundaries without importing either parser', () => {
    expect(DOCX_ADAPTER_INTEGRATION.version).toBe('0.4.0');
    expect(DOCX_ADAPTER_INTEGRATION.api).toContain('renderAsync');
    expect(WORKBOOK_ADAPTER_INTEGRATION.packageName).toBe('read-excel-file');
    expect(WORKBOOK_ADAPTER_INTEGRATION.version).toBe('9.3.10');
    expect(WORKBOOK_ADAPTER_INTEGRATION.supportedFormats).toEqual(['xlsx']);
  });

  it('maps detached DOCX output to safe text/table semantics and strips active content', async () => {
    const document = new FakeDocument();
    const module = makeDocxModule(document);
    const adapter = createDocxPreviewAdapter(module, {
      documentFactory: () => document as unknown as Document,
      limits: { maxBlocksPerPage: 10, maxTableRows: 1 },
    });

    const result = await adapter.load(new ArrayBuffer(4), { fileName: 'unsafe.docx' });
    const serialized = JSON.stringify(result);

    expect(result.pages).toHaveLength(1);
    const resultPage = result.pages[0];
    if (resultPage === undefined) throw new Error('The DOCX fixture did not return a page.');
    expect(resultPage.blocks).toHaveLength(2);
    const firstBlock = resultPage.blocks[0];
    if (firstBlock === undefined || firstBlock.kind === 'table') {
      throw new Error('The DOCX fixture did not return a text block.');
    }
    expect(firstBlock).toMatchObject({ kind: 'paragraph', x: 48, y: 48 });
    const paragraphRuns = firstBlock.runs;
    expect(paragraphRuns.map((run) => run.text).join('')).toBe('Visible linked text');
    expect(resultPage.blocks[1]).toMatchObject({
      kind: 'table',
      rows: [[{ runs: [{ text: 'A' }] }]],
    });
    expect(result.truncated).toBe(true);
    expect(serialized).not.toContain('<script');
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('href');
    expect(module.renderAsync as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        renderAltChunks: false,
        renderComments: false,
        renderChanges: false,
      }),
    );
  });

  it('advances fallback DOCX flow past variable-height blocks', async () => {
    const document = new FakeDocument();
    const module: DocxPreviewModule = {
      renderAsync: vi.fn(async (_source, body) => {
        const page = document.createElement('section');
        page.setAttribute('class', 'docx');
        page.setAttribute('style', 'width: 816px; height: 1056px');
        const before = document.createElement('p');
        appendText(document, before, 'Before table');
        page.appendChild(before);
        const table = document.createElement('table');
        for (const value of ['one', 'two', 'three']) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          appendText(document, cell, value);
          row.appendChild(cell);
          table.appendChild(row);
        }
        page.appendChild(table);
        const after = document.createElement('p');
        appendText(document, after, 'After table');
        page.appendChild(after);
        (body as unknown as FakeElement).appendChild(page);
      }),
    };
    const adapter = createDocxPreviewAdapter(module, {
      documentFactory: () => document as unknown as Document,
    });

    const result = await adapter.load(new ArrayBuffer(4), { fileName: 'flow.docx' });
    const blocks = result.pages[0]?.blocks ?? [];
    const table = blocks[1];
    const after = blocks[2];
    expect(table?.kind).toBe('table');
    expect(after?.y).toBeGreaterThanOrEqual((table?.y ?? 0) + (table?.height ?? 0));
  });

  it('rejects oversized and cancelled DOCX loads before parser work', async () => {
    const document = new FakeDocument();
    const module = makeDocxModule(document);
    const adapter = createDocxPreviewAdapter(module, {
      documentFactory: () => document as unknown as Document,
      limits: { maxSourceBytes: 8 },
    });
    await expect(adapter.load(new ArrayBuffer(9), { fileName: 'large.docx' })).rejects.toThrow(
      'preview limit',
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.load(
        new ArrayBuffer(1),
        { fileName: 'cancelled.docx' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(module.renderAsync).not.toHaveBeenCalled();
  });

  it('normalizes modern XLSX parser output with inert formula flags and merged spans', async () => {
    const read = vi.fn(async (_source: ArrayBuffer, options) => {
      expect(options).toMatchObject({
        externalLinks: 'ignore',
        formulas: 'inert',
        format: 'xlsx',
        macros: 'ignore',
      });
      return {
        sheets: [
          {
            cells: [
              { column: 0, displayText: '42', formula: 'SUM(A1:A2)', row: 0, value: '=SUM(A1:A2)' },
              { column: 1, displayText: '<script>alert(1)</script>', row: 0 },
              { column: 2, displayText: 'Merged', row: 1 },
            ],
            columnCount: 5,
            mergedRanges: [{ colSpan: 2, column: 2, row: 1, rowSpan: 2 }],
            name: 'Summary',
            rowCount: 10,
          },
        ],
      };
    });
    const parser: WorkbookParserModule = { read };
    const adapter = createWorkbookPreviewAdapter(parser, {
      limits: { maxCells: 2, maxColumns: 4, maxRows: 4 },
    });

    const result = await adapter.load(new ArrayBuffer(6), {
      fileName: 'summary.xlsx',
      format: 'xlsx',
    });
    const sheet = result.sheets[0];
    if (sheet === undefined) throw new Error('The parser fixture did not return a sheet.');
    const html = renderToStaticMarkup(createElement(WorkbookSheetGrid, { sheet }));

    expect(read).toHaveBeenCalledOnce();
    expect(sheet?.rowCount).toBe(4);
    expect(sheet?.columnCount).toBe(4);
    expect(sheet?.cells[0]).toMatchObject({ formula: 'SUM(A1:A2)', value: '42' });
    expect(result.truncated).toBe(true);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href=');
  });

  it('keeps legacy XLS and ODS download-only', async () => {
    const read = vi.fn(async () => ({ sheets: [] }));
    const adapter = createWorkbookPreviewAdapter({ read });

    await expect(
      adapter.load(new ArrayBuffer(1), { fileName: 'legacy.xls', format: 'xls' }),
    ).rejects.toThrow('download-only');
    await expect(
      adapter.load(new ArrayBuffer(1), { fileName: 'sheet.ods', format: 'ods' }),
    ).rejects.toThrow('download-only');
    expect(read).not.toHaveBeenCalled();
  });

  it('binds the real browser XLSX package against a tiny workbook fixture', async () => {
    const adapter = await loadWorkbookPreviewAdapter();
    const result = await adapter.load(tinyXlsxFixture(), {
      fileName: 'tiny.xlsx',
      format: 'xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const sheet = result.sheets[0];
    expect(sheet).toMatchObject({ columnCount: 2, name: 'Summary', rowCount: 2 });
    expect(sheet?.cells.map((cell) => cell.value)).toEqual(['Revenue', '42', '42', 'Safe & inert']);
  });
});
