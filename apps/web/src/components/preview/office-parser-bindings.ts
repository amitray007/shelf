import {
  createDocxPreviewAdapter,
  createWorkbookPreviewAdapter,
  type DocxPreviewModule,
  type WorkbookParserModule,
  type WorkbookParserReadOptions,
  type WorkbookParserSheet,
} from './office-adapters.js';
import type { DocxPreviewAdapter } from './office-document-preview.js';
import type { WorkbookPreviewAdapter } from './workbook-preview.js';

/** The browser entry exported by read-excel-file@9.3.10. */
export interface ReadExcelFileModule {
  readonly default: (
    source: ArrayBuffer,
    options?: Readonly<{ trim?: boolean | undefined }>,
  ) => Promise<readonly ReadExcelSheet[]>;
}

export interface ReadExcelSheet {
  readonly sheet: string;
  readonly data: readonly (readonly unknown[])[];
}

export const OFFICE_PARSER_LIMITS = {
  docxSourceBytes: 25 * 1024 * 1024,
  workbookSourceBytes: 50 * 1024 * 1024,
} as const;

function displayText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  return String(value);
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.floor(value as number);
}

function normalizeReadExcelSheet(
  sheet: ReadExcelSheet,
  options: WorkbookParserReadOptions,
): WorkbookParserSheet {
  const sourceRows = Array.isArray(sheet.data) ? sheet.data : [];
  const rowCount = sourceRows.length;
  const columnCount = sourceRows.reduce(
    (maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0),
    0,
  );
  const maxRows = positiveBound(options.maxRows, rowCount || 1);
  const maxColumns = positiveBound(options.maxColumns, columnCount || 1);
  const maxCells = positiveBound(options.maxCells, Number.MAX_SAFE_INTEGER);
  const cells: WorkbookParserSheet['cells'][number][] = [];
  let truncated = rowCount > maxRows || columnCount > maxColumns;

  for (let row = 0; row < Math.min(rowCount, maxRows); row += 1) {
    const values = sourceRows[row];
    if (!Array.isArray(values)) continue;
    for (let column = 0; column < Math.min(values.length, maxColumns); column += 1) {
      const value = values[column];
      if (value === undefined || value === null) continue;
      if (cells.length >= maxCells) {
        truncated = true;
        break;
      }
      cells.push({ row, column, displayText: displayText(value) });
    }
    if (cells.length >= maxCells) {
      truncated = true;
      break;
    }
  }

  return {
    cells,
    columnCount,
    name: String(sheet.sheet),
    rowCount,
    truncated,
  };
}

/** Converts the real read-excel-file browser result into the adapter's inert display port. */
export function createReadExcelFileParser(module: ReadExcelFileModule): WorkbookParserModule {
  return {
    async read(source, options) {
      const sheets = await module.default(source, { trim: false });
      return {
        sheets: sheets.map((sheet) => normalizeReadExcelSheet(sheet, options)),
      };
    },
  };
}

/** Lazy browser binding. Parser code is loaded only when a DOCX is selected. */
export async function loadDocxPreviewAdapter(): Promise<DocxPreviewAdapter> {
  const module = (await import('docx-preview')) as DocxPreviewModule;
  return createDocxPreviewAdapter(module, {
    limits: { maxSourceBytes: OFFICE_PARSER_LIMITS.docxSourceBytes },
  });
}

/** Lazy browser binding for maintained XLSX-only parsing. */
export async function loadWorkbookPreviewAdapter(): Promise<WorkbookPreviewAdapter> {
  const module = (await import('read-excel-file/browser')) as ReadExcelFileModule;
  return createWorkbookPreviewAdapter(createReadExcelFileParser(module), {
    limits: { maxSourceBytes: OFFICE_PARSER_LIMITS.workbookSourceBytes },
  });
}
