// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable table previews must be keyboard reachable.

import { useEffect, useId, useRef, useState } from 'react';

import {
  ParseErrorNotice,
  type PreviewMode,
  PreviewModeTabs,
  PreviewPanel,
  SourcePane,
} from './preview-shared.js';

export type DelimitedFormat = 'csv' | 'tsv';

export interface DelimitedTablePreviewProps {
  readonly source: string;
  readonly fileName?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly delimiter?: string | undefined;
  readonly initialMode?: PreviewMode | undefined;
  /** Hide the inner mode tabs when an outer file viewer owns Preview/Source. */
  readonly showModeTabs?: boolean | undefined;
  /** Hide the inner filename/format row when an outer share toolbar owns identity. */
  readonly showFileIdentity?: boolean | undefined;
  readonly maxRows?: number | undefined;
  readonly maxColumns?: number | undefined;
  readonly maxCellLength?: number | undefined;
  readonly maxSourceLength?: number | undefined;
  readonly maxVisibleRows?: number | undefined;
}

export interface DelimitedParseOptions {
  readonly delimiter?: string | undefined;
  readonly maxRows?: number | undefined;
  readonly maxColumns?: number | undefined;
  readonly maxCellLength?: number | undefined;
  readonly maxSourceLength?: number | undefined;
}

export type DelimitedParseResult =
  | {
      readonly columnCount: number;
      readonly format: DelimitedFormat;
      readonly headers: readonly string[];
      readonly ok: true;
      readonly rows: readonly (readonly string[])[];
      readonly truncated: boolean;
    }
  | {
      readonly error: string;
      readonly format: DelimitedFormat;
      readonly ok: false;
    };

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_COLUMNS = 250;
const DEFAULT_MAX_CELL_LENGTH = 100_000;
const DEFAULT_MAX_SOURCE_LENGTH = 4_000_000;
const DEFAULT_MAX_VISIBLE_ROWS = 250;

function inferDelimitedFormat(fileName = '', mediaType = ''): DelimitedFormat {
  const normalizedMediaType = mediaType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return normalizedMediaType.includes('tab-separated') || /\.tsv$/iu.test(fileName) ? 'tsv' : 'csv';
}

export function parseDelimitedSource(
  source: string,
  {
    delimiter,
    fileName,
    mediaType,
    maxCellLength = DEFAULT_MAX_CELL_LENGTH,
    maxColumns = DEFAULT_MAX_COLUMNS,
    maxRows = DEFAULT_MAX_ROWS,
    maxSourceLength = DEFAULT_MAX_SOURCE_LENGTH,
  }: DelimitedParseOptions & {
    readonly fileName?: string | undefined;
    readonly mediaType?: string | undefined;
  } = {},
): DelimitedParseResult {
  const format = inferDelimitedFormat(fileName, mediaType);
  const separator = delimiter ?? (format === 'tsv' ? '\t' : ',');
  if (separator.length !== 1) {
    return { error: 'The delimiter must be exactly one character.', format, ok: false };
  }
  if (source.length > maxSourceLength) {
    return {
      error: `Source is too large to inspect (limit ${maxSourceLength.toLocaleString()} characters).`,
      format,
      ok: false,
    };
  }

  const normalizedSource = source.startsWith('\uFEFF') ? source.slice(1) : source;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let lineNumber = 1;
  let truncated = false;
  let stopped = false;

  const fail = (message: string): DelimitedParseResult => ({
    error: `${format.toUpperCase()} line ${lineNumber}: ${message}`,
    format,
    ok: false,
  });

  const pushField = (): DelimitedParseResult | null => {
    if (field.length > maxCellLength) {
      return fail(`a cell exceeds the ${maxCellLength.toLocaleString()} character limit.`);
    }
    if (row.length >= maxColumns) {
      return fail(`a row exceeds the ${maxColumns.toLocaleString()} column limit.`);
    }
    row.push(field);
    field = '';
    return null;
  };

  const pushRow = (): DelimitedParseResult | null => {
    const fieldError = pushField();
    if (fieldError !== null) return fieldError;
    rows.push(row);
    row = [];
    if (rows.length >= maxRows + 1) {
      truncated = true;
      stopped = true;
    }
    return null;
  };

  for (let index = 0; index < normalizedSource.length && !stopped; index += 1) {
    const character = normalizedSource[index] ?? '';
    if (quoted) {
      if (character === '"') {
        if (normalizedSource[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
        if (character === '\n') lineNumber += 1;
        else if (character === '\r' && normalizedSource[index + 1] !== '\n') lineNumber += 1;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ' ' || character === '\t') continue;
      if (character === separator) {
        const fieldError = pushField();
        if (fieldError !== null) return fieldError;
        closedQuote = false;
        continue;
      }
      if (character === '\n' || character === '\r') {
        const rowError = pushRow();
        if (rowError !== null) return rowError;
        closedQuote = false;
        if (character === '\r' && normalizedSource[index + 1] === '\n') index += 1;
        lineNumber += 1;
        continue;
      }
      return fail('unexpected content after a closing quote.');
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (character === '"') return fail('a quote can only start a quoted field.');
    if (character === separator) {
      const fieldError = pushField();
      if (fieldError !== null) return fieldError;
      continue;
    }
    if (character === '\n' || character === '\r') {
      const rowError = pushRow();
      if (rowError !== null) return rowError;
      if (character === '\r' && normalizedSource[index + 1] === '\n') index += 1;
      lineNumber += 1;
      continue;
    }
    field += character;
  }

  if (quoted) return fail('an opening quote has no closing quote.');
  if (
    !stopped &&
    (field.length > 0 ||
      row.length > 0 ||
      closedQuote ||
      (normalizedSource.length > 0 &&
        !normalizedSource.endsWith('\n') &&
        !normalizedSource.endsWith('\r')))
  ) {
    const rowError = pushRow();
    if (rowError !== null) return rowError;
  }

  if (rows.length === 0) {
    return { columnCount: 0, format, headers: [], ok: true, rows: [], truncated: false };
  }

  const columnCount = Math.max(...rows.map((candidate) => candidate.length));
  if (columnCount > maxColumns) {
    return {
      error: `The table exceeds the ${maxColumns.toLocaleString()} column limit.`,
      format,
      ok: false,
    };
  }
  const headerRow = rows[0] ?? [];
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const value = headerRow[index] ?? '';
    return value.trim().length === 0 ? `Column ${index + 1}` : value;
  });
  const headerNames = new Map<string, number>();
  const uniqueHeaders = headers.map((header) => {
    const seen = (headerNames.get(header) ?? 0) + 1;
    headerNames.set(header, seen);
    return seen === 1 ? header : `${header} (${seen})`;
  });
  const normalizedRows = rows
    .slice(1)
    .map((candidate) => Array.from({ length: columnCount }, (_, index) => candidate[index] ?? ''));
  return { columnCount, format, headers: uniqueHeaders, ok: true, rows: normalizedRows, truncated };
}

function displayCell(
  value: string,
  maxLength = 180,
): { readonly label: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { label: value, truncated: false };
  return { label: `${value.slice(0, maxLength)}…`, truncated: true };
}

interface SelectedCell {
  readonly column: string;
  readonly row: number;
  readonly value: string;
}

function CellInspector({
  cell,
  onClose,
}: {
  readonly cell: SelectedCell;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="preview-inspector-backdrop">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="preview-inspector"
        role="dialog"
      >
        <div className="preview-inspector-header">
          <strong id={titleId}>
            Row {cell.row}, {cell.column}
          </strong>
          <button
            aria-label="Close cell inspector"
            className="preview-inspector-close"
            onClick={onClose}
            ref={closeButton}
            type="button"
          >
            Close
          </button>
        </div>
        <pre className="preview-inspector-content">
          {cell.value.length === 0 ? '(empty)' : cell.value}
        </pre>
      </section>
    </div>
  );
}

export function DelimitedTablePreview({
  delimiter,
  fileName = 'data.csv',
  initialMode,
  maxCellLength,
  maxColumns,
  maxRows,
  maxSourceLength,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  mediaType,
  showFileIdentity = true,
  showModeTabs = true,
  source,
}: DelimitedTablePreviewProps) {
  const [mode, setMode] = useState<PreviewMode>(initialMode ?? 'preview');
  const activeMode = showModeTabs ? mode : 'preview';
  const [query, setQuery] = useState('');
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const searchId = useId();
  const parsed = parseDelimitedSource(source, {
    delimiter,
    fileName,
    ...(maxCellLength === undefined ? {} : { maxCellLength }),
    ...(maxColumns === undefined ? {} : { maxColumns }),
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(maxSourceLength === undefined ? {} : { maxSourceLength }),
    mediaType,
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingRows = parsed.ok
    ? parsed.rows
        .map((row, index) => ({ index, row }))
        .filter(
          ({ row }) =>
            normalizedQuery.length === 0 ||
            row.some((cell) => cell.toLocaleLowerCase().includes(normalizedQuery)),
        )
    : [];
  const visibleRows = matchingRows.slice(0, Math.max(1, maxVisibleRows));
  const hasMoreVisibleRows = matchingRows.length > visibleRows.length;

  useEffect(() => {
    if (mode === 'source') setSelectedCell(null);
  }, [mode]);

  return (
    <section
      aria-label={`${fileName} table preview`}
      className="preview-component delimited-table-preview"
    >
      {showFileIdentity || showModeTabs ? (
        <div className="preview-toolbar">
          {showFileIdentity ? (
            <div className="preview-toolbar-start">
              <span className="preview-toolbar-label" title={fileName}>
                {fileName}
              </span>
              <span className="preview-toolbar-meta">
                {parsed.ok ? parsed.format.toUpperCase() : 'Source'}
              </span>
            </div>
          ) : null}
          {showModeTabs ? <PreviewModeTabs activeMode={mode} onModeChange={setMode} /> : null}
        </div>
      ) : null}
      {activeMode === 'source' ? (
        <PreviewPanel label={`${fileName} source`}>
          <SourcePane source={source} />
        </PreviewPanel>
      ) : parsed.ok ? (
        <PreviewPanel label={`${fileName} table`}>
          <div className="preview-toolbar">
            <div className="preview-toolbar-start delimited-table-search-wrap">
              <label htmlFor={searchId}>Filter rows</label>
              <input
                aria-label="Filter table rows"
                className="preview-search delimited-table-search"
                id={searchId}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter rows"
                type="search"
                value={query}
              />
            </div>
            <span className="preview-toolbar-meta">
              {matchingRows.length.toLocaleString()} of {parsed.rows.length.toLocaleString()} rows
            </span>
          </div>
          {parsed.columnCount === 0 ? (
            <p className="delimited-table-empty">This table has no rows.</p>
          ) : (
            <section
              aria-label={`${fileName} horizontally scrollable table`}
              className="delimited-table-scroll"
              tabIndex={0}
            >
              <table className="delimited-table">
                <caption className="visually-hidden">{fileName} data table</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="delimited-table-header">Row</span>
                    </th>
                    {parsed.headers.map((header) => (
                      <th key={header} scope="col">
                        <span className="delimited-table-header" title={header}>
                          {header}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(({ index, row }) => (
                    <tr className="delimited-table-row" key={`row-${index}`}>
                      <td>
                        <span className="delimited-table-row-number">{index + 1}</span>
                      </td>
                      {row.map((cell, columnIndex) => {
                        const displayed = displayCell(cell);
                        const column = parsed.headers[columnIndex] ?? `Column ${columnIndex + 1}`;
                        return (
                          <td key={column}>
                            <button
                              aria-label={`Row ${index + 1}, ${column}: ${cell.length === 0 ? 'empty' : cell}`}
                              className="preview-cell-button"
                              onClick={() =>
                                setSelectedCell({ column, row: index + 1, value: cell })
                              }
                              title={cell}
                              type="button"
                            >
                              {displayed.label}
                              {displayed.truncated ? <span aria-hidden="true"> </span> : null}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {parsed.truncated || hasMoreVisibleRows ? (
            <p className="delimited-table-caption">
              Showing the first {visibleRows.length.toLocaleString()} matching rows. Source mode
              contains the complete file.
            </p>
          ) : null}
        </PreviewPanel>
      ) : (
        <PreviewPanel label={`${fileName} parse error`}>
          <ParseErrorNotice error={parsed.error} source={source} />
        </PreviewPanel>
      )}
      {selectedCell === null ? null : (
        <CellInspector cell={selectedCell} onClose={() => setSelectedCell(null)} />
      )}
    </section>
  );
}
