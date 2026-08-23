import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  boundWorkbookModel,
  DEFAULT_WORKBOOK_PREVIEW_LIMITS,
  WORKBOOK_INTEGRATION,
  WorkbookPreview,
  type WorkbookPreviewModel,
  WorkbookSheetGrid,
  workbookColumnLabel,
} from '../src/components/preview/workbook-preview.js';

describe('workbook adapter and grid contracts', () => {
  it('covers the supported workbook formats at a source-backed parser version', () => {
    expect(WORKBOOK_INTEGRATION.packageName).toBe('read-excel-file');
    expect(WORKBOOK_INTEGRATION.version).toBe('9.3.10');
    expect(WORKBOOK_INTEGRATION.note).toContain('download-only');
    expect(WORKBOOK_INTEGRATION.supportedFormats).toEqual(['xlsx']);
    expect(WORKBOOK_INTEGRATION.source).toContain('gitlab.com/catamphetamine/read-excel-file');
  });

  it('converts zero-based columns into spreadsheet labels', () => {
    expect(workbookColumnLabel(0)).toBe('A');
    expect(workbookColumnLabel(25)).toBe('Z');
    expect(workbookColumnLabel(26)).toBe('AA');
    expect(workbookColumnLabel(701)).toBe('ZZ');
    expect(workbookColumnLabel(702)).toBe('AAA');
  });

  it('bounds sheets, dimensions, cells, and merged spans', () => {
    const model: WorkbookPreviewModel = {
      sheets: [
        {
          cells: [
            { colSpan: 3, column: 0, row: 0, rowSpan: 3, value: 'Merged title' },
            { column: 0, row: 1, value: '=SUM(A1:A2)', formula: 'SUM(A1:A2)' },
            { column: 4, row: 4, value: 'discarded' },
          ],
          columnCount: 6,
          name: 'Summary',
          rowCount: 6,
        },
      ],
    };
    const bounded = boundWorkbookModel(model, {
      ...DEFAULT_WORKBOOK_PREVIEW_LIMITS,
      maxCells: 2,
      maxColumns: 4,
      maxRows: 4,
    });

    expect(bounded.truncated).toBe(true);
    expect(bounded.sheets[0]?.rowCount).toBe(4);
    expect(bounded.sheets[0]?.columnCount).toBe(4);
    expect(bounded.sheets[0]?.cells).toHaveLength(2);
    expect(bounded.sheets[0]?.cells[0]?.rowSpan).toBe(3);
    expect(bounded.sheets[0]?.cells[0]?.colSpan).toBe(3);
  });

  it('renders bounded, scrollable grid headers and formula values as inert text', () => {
    const html = renderToStaticMarkup(
      <WorkbookSheetGrid
        maxRenderedColumns={2}
        maxRenderedRows={2}
        sheet={{
          cells: [
            { column: 0, row: 0, value: 'Revenue' },
            { column: 1, row: 0, value: '=SUM(A1:A2)', formula: 'SUM(A1:A2)' },
            { colSpan: 2, column: 0, row: 1, rowSpan: 2, value: 'Merged' },
          ],
          columnCount: 6,
          name: 'Summary',
          rowCount: 20,
        }}
      />,
    );

    expect(html).toContain('aria-label="Summary workbook grid"');
    expect(html).toContain('A');
    expect(html).toContain('B');
    expect(html).toContain('aria-label="A1: Revenue"');
    expect(html).toContain('data-formula="inert"');
    expect(html).toContain('=SUM(A1:A2)');
    expect(html).toContain('style="height:64px');
    expect(html).toContain('style="left:0;top:0"');
    expect(html).toContain('left:56px;top:0;width:168px');
    expect(html).toContain('height:672px;width:1064px');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('href=');
  });

  it('shows the loading surface without accepting credentials or capabilities', () => {
    const html = renderToStaticMarkup(
      <WorkbookPreview
        metadata={{
          fileName: 'budget.ods',
          format: 'ods',
          mediaType: 'application/vnd.oasis.opendocument.spreadsheet',
        }}
        src="https://preview.example.test/budget.ods"
        title="Budget workbook"
      />,
    );

    expect(html).toContain('data-preview-kind="workbook"');
    expect(html).toContain('Loading workbook');
    expect(html).toContain('Values and formulas are displayed as inert text');
    expect(html).not.toContain('token');
    expect(html).not.toContain('capability');
  });
});
