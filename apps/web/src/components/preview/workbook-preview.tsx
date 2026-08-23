// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The workbook grid is a keyboard-reachable scroll surface.
// biome-ignore-all lint/a11y/useSemanticElements: A positioned virtual grid cannot use table layout.

import { CaretLeftIcon } from '@phosphor-icons/react/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight';
import { SpinnerGapIcon } from '@phosphor-icons/react/SpinnerGap';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import type { CSSProperties, UIEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { OfficeDocumentMetadata, OfficeDocumentSource } from './office-document-preview.js';
import { loadWorkbookPreviewAdapter } from './office-parser-bindings.js';
import './workbook-preview.css';

export type WorkbookFormat = 'xlsx' | 'xls' | 'ods';

export interface WorkbookCell {
  /** Zero-based row and column coordinates. */
  readonly row: number;
  readonly column: number;
  /** Already formatted display text. Formula strings remain inert text. */
  readonly value: string;
  readonly formula?: string | undefined;
  readonly rowSpan?: number | undefined;
  readonly colSpan?: number | undefined;
}

export interface WorkbookSheet {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly cells: readonly WorkbookCell[];
}

export interface WorkbookPreviewModel {
  readonly sheets: readonly WorkbookSheet[];
  readonly truncated?: boolean | undefined;
}

export interface WorkbookPreviewMetadata extends OfficeDocumentMetadata {
  readonly format: WorkbookFormat;
}

export interface WorkbookPreviewLoadOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface WorkbookPreviewAdapter {
  /** Parse one workbook source into display values. The adapter must not evaluate formulas in the UI. */
  readonly load: (
    source: OfficeDocumentSource,
    metadata: WorkbookPreviewMetadata,
    options?: WorkbookPreviewLoadOptions | undefined,
  ) => Promise<WorkbookPreviewModel>;
}

/**
 * The grid accepts display-only values from a parser adapter. The app binds the maintained browser
 * reader for modern XLSX; legacy XLS/ODS stay download-only.
 */
export const WORKBOOK_INTEGRATION = {
  packageName: 'read-excel-file',
  version: '9.3.10',
  source: 'https://gitlab.com/catamphetamine/read-excel-file',
  note: 'The browser reader returns display values. XLS and ODS remain download-only.',
  supportedFormats: ['xlsx'] as const,
} as const;

export interface WorkbookPreviewLimits {
  readonly maxSourceBytes: number;
  readonly maxSheets: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCells: number;
  readonly maxRenderedRows: number;
  readonly maxRenderedColumns: number;
}

export const DEFAULT_WORKBOOK_PREVIEW_LIMITS: WorkbookPreviewLimits = {
  maxCells: 300_000,
  maxColumns: 256,
  maxRenderedColumns: 28,
  maxRenderedRows: 80,
  maxRows: 100_000,
  maxSheets: 100,
  maxSourceBytes: 50 * 1024 * 1024,
};

const ROW_HEIGHT = 32;
const MIN_COLUMN_WIDTH = 168;
const HEADER_HEIGHT = 32;
const ROW_HEADER_WIDTH = 56;
const OVERSCAN = 4;

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveLimit(value: number, fallback: number): number {
  const normalized = positiveInteger(value, fallback);
  return normalized > 0 ? normalized : fallback;
}

function cellSpan(value: number | undefined): number {
  return Math.max(1, positiveInteger(value ?? 1, 1));
}

function cellInBounds(cell: WorkbookCell, rowCount: number, columnCount: number): boolean {
  return (
    cell.row >= 0 &&
    cell.column >= 0 &&
    cell.row < rowCount &&
    cell.column < columnCount &&
    Number.isFinite(cell.row) &&
    Number.isFinite(cell.column)
  );
}

export function boundWorkbookModel(
  model: WorkbookPreviewModel,
  limits: WorkbookPreviewLimits = DEFAULT_WORKBOOK_PREVIEW_LIMITS,
): WorkbookPreviewModel {
  const maxSheets = positiveLimit(limits.maxSheets, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxSheets);
  const maxRows = positiveLimit(limits.maxRows, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRows);
  const maxColumns = positiveLimit(limits.maxColumns, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxColumns);
  const maxCells = positiveLimit(limits.maxCells, DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxCells);
  let truncated = model.truncated === true || model.sheets.length > maxSheets;
  const sheets = model.sheets.slice(0, maxSheets).map((sheet) => {
    const rowCount = Math.min(maxRows, positiveInteger(sheet.rowCount, 0));
    const columnCount = Math.min(maxColumns, positiveInteger(sheet.columnCount, 0));
    if (rowCount !== sheet.rowCount || columnCount !== sheet.columnCount) truncated = true;
    const cells: WorkbookCell[] = [];
    for (const cell of sheet.cells) {
      if (!cellInBounds(cell, rowCount, columnCount)) {
        if (cell.row >= rowCount || cell.column >= columnCount) truncated = true;
        continue;
      }
      if (cells.length >= maxCells) {
        truncated = true;
        break;
      }
      cells.push({
        ...cell,
        colSpan: Math.min(cellSpan(cell.colSpan), columnCount - cell.column),
        rowSpan: Math.min(cellSpan(cell.rowSpan), rowCount - cell.row),
      });
    }
    if (cells.length !== sheet.cells.length) truncated = true;
    return { ...sheet, cells, columnCount, rowCount };
  });
  return { sheets, truncated };
}

export function workbookColumnLabel(column: number): string {
  let value = Math.max(0, Math.floor(column));
  let label = '';
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function sourceSize(source: OfficeDocumentSource): number | undefined {
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (source instanceof Blob) return source.size;
  return undefined;
}

function safeCellText(cell: WorkbookCell): string {
  return typeof cell.value === 'string' ? cell.value : String(cell.value);
}

interface WorkbookGridProps {
  readonly sheet: WorkbookSheet;
  readonly maxRenderedRows?: number | undefined;
  readonly maxRenderedColumns?: number | undefined;
  readonly className?: string | undefined;
}

export function WorkbookSheetGrid({
  className,
  maxRenderedColumns = DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRenderedColumns,
  maxRenderedRows = DEFAULT_WORKBOOK_PREVIEW_LIMITS.maxRenderedRows,
  sheet,
}: WorkbookGridProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 });
  const [viewportWidth, setViewportWidth] = useState(0);
  const safeRowCount = positiveInteger(sheet.rowCount, 0);
  const safeColumnCount = positiveInteger(sheet.columnCount, 0);
  const visibleRowLimit = positiveLimit(maxRenderedRows, 20);
  const visibleColumnLimit = positiveLimit(maxRenderedColumns, 12);
  const availableColumnWidth = Math.max(0, viewportWidth - ROW_HEADER_WIDTH);
  const columnWidth =
    safeColumnCount === 0
      ? MIN_COLUMN_WIDTH
      : Math.max(MIN_COLUMN_WIDTH, availableColumnWidth / safeColumnCount);
  const rowStart = Math.max(0, Math.floor(scrollPosition.top / ROW_HEIGHT) - OVERSCAN);
  const columnStart = Math.max(0, Math.floor(scrollPosition.left / columnWidth) - OVERSCAN);
  const rowEnd = Math.min(safeRowCount, rowStart + visibleRowLimit + OVERSCAN * 2);
  const columnEnd = Math.min(safeColumnCount, columnStart + visibleColumnLimit + OVERSCAN * 2);

  const visibleCells = useMemo(
    () =>
      sheet.cells.filter((cell) => {
        const rowSpan = cellSpan(cell.rowSpan);
        const colSpan = cellSpan(cell.colSpan);
        return (
          cell.row < rowEnd &&
          cell.row + rowSpan > rowStart &&
          cell.column < columnEnd &&
          cell.column + colSpan > columnStart
        );
      }),
    [columnEnd, columnStart, rowEnd, rowStart, sheet.cells],
  );

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollPosition({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop });
  };
  useEffect(() => {
    void sheet.name;
    setScrollPosition({ left: 0, top: 0 });
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  }, [sheet.name]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const gridHeight = HEADER_HEIGHT + safeRowCount * ROW_HEIGHT;
  const gridWidth = ROW_HEADER_WIDTH + safeColumnCount * columnWidth;
  const gridClassName = ['workbook-grid-viewport', className].filter(Boolean).join(' ');

  return (
    <div
      aria-label={`${sheet.name} workbook grid`}
      aria-rowcount={safeRowCount}
      className={gridClassName}
      onScroll={onScroll}
      ref={viewportRef}
      role="grid"
      tabIndex={0}
    >
      <div
        className="workbook-grid-canvas"
        style={{
          height: gridHeight,
          width: gridWidth,
        }}
      >
        <div
          className="workbook-grid-corner"
          role="columnheader"
          style={{ left: scrollPosition.left, top: scrollPosition.top }}
          tabIndex={-1}
        >
          #
        </div>
        {Array.from({ length: Math.max(0, columnEnd - columnStart) }, (_, index) => {
          const column = columnStart + index;
          const style = {
            left: ROW_HEADER_WIDTH + column * columnWidth,
            top: scrollPosition.top,
            width: columnWidth,
          } satisfies CSSProperties;
          return (
            <div
              aria-colindex={column + 1}
              className="workbook-grid-column-header"
              key={`column:${column}`}
              role="columnheader"
              style={style}
              tabIndex={-1}
            >
              {workbookColumnLabel(column)}
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, rowEnd - rowStart) }, (_, index) => {
          const row = rowStart + index;
          const style = {
            left: scrollPosition.left,
            top: HEADER_HEIGHT + row * ROW_HEIGHT,
          } satisfies CSSProperties;
          return (
            <div
              aria-rowindex={row + 1}
              className="workbook-grid-row-header"
              key={`row:${row}`}
              role="rowheader"
              style={style}
              tabIndex={-1}
            >
              {row + 1}
            </div>
          );
        })}
        {visibleCells.map((cell) => {
          const rowSpan = Math.min(cellSpan(cell.rowSpan), safeRowCount - cell.row);
          const colSpan = Math.min(cellSpan(cell.colSpan), safeColumnCount - cell.column);
          const style = {
            height: rowSpan * ROW_HEIGHT,
            left: ROW_HEADER_WIDTH + cell.column * columnWidth,
            top: HEADER_HEIGHT + cell.row * ROW_HEIGHT,
            width: colSpan * columnWidth,
          } satisfies CSSProperties;
          const coordinate = `${cell.row}:${cell.column}`;
          const value = safeCellText(cell);
          return (
            <div
              aria-colindex={cell.column + 1}
              aria-label={`${workbookColumnLabel(cell.column)}${cell.row + 1}: ${value || 'blank'}`}
              aria-rowindex={cell.row + 1}
              className="workbook-grid-cell"
              data-formula={cell.formula === undefined ? undefined : 'inert'}
              key={coordinate}
              role="gridcell"
              style={style}
              tabIndex={-1}
              title={cell.formula === undefined ? undefined : 'Formula shown as inert text'}
            >
              {value}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface WorkbookPreviewProps {
  readonly src: OfficeDocumentSource;
  readonly metadata: WorkbookPreviewMetadata;
  readonly adapter?: WorkbookPreviewAdapter | undefined;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
  /** Hide the filename row when an outer share toolbar owns file identity. */
  readonly showFileIdentity?: boolean | undefined;
  readonly limits?: Partial<WorkbookPreviewLimits> | undefined;
  readonly initialSheet?: string | undefined;
}

function mergedLimits(limits: Partial<WorkbookPreviewLimits> | undefined): WorkbookPreviewLimits {
  return { ...DEFAULT_WORKBOOK_PREVIEW_LIMITS, ...limits };
}

export function WorkbookPreview({
  adapter,
  className,
  initialSheet,
  limits: limitOverrides,
  metadata,
  showFileIdentity = true,
  src,
  title = 'Workbook preview',
}: WorkbookPreviewProps) {
  const limits = useMemo(() => mergedLimits(limitOverrides), [limitOverrides]);
  const [model, setModel] = useState<WorkbookPreviewModel | null>(null);
  const [selectedSheet, setSelectedSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void reloadToken;
    setModel(null);
    setSelectedSheet(0);
    setErrorMessage(undefined);
    const bytes = sourceSize(src);
    if (bytes !== undefined && bytes > limits.maxSourceBytes) {
      setLoading(false);
      setErrorMessage(
        `This workbook is larger than the ${Math.round(limits.maxSourceBytes / 1_000_000)} MB preview limit.`,
      );
      return () => {
        disposed = true;
      };
    }
    setLoading(true);
    const adapterPromise =
      adapter === undefined ? loadWorkbookPreviewAdapter() : Promise.resolve(adapter);
    void adapterPromise
      .then((resolvedAdapter) => resolvedAdapter.load(src, metadata, { signal: controller.signal }))
      .then((nextModel) => {
        if (disposed) return;
        const bounded = boundWorkbookModel(nextModel, limits);
        if (bounded.sheets.length === 0) {
          setErrorMessage('The workbook has no visible sheets.');
          setLoading(false);
          return;
        }
        const initialIndex =
          initialSheet === undefined
            ? 0
            : Math.max(
                0,
                bounded.sheets.findIndex((sheet) => sheet.name === initialSheet),
              );
        setSelectedSheet(initialIndex);
        setModel(bounded);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setLoading(false);
        setErrorMessage(
          error instanceof Error ? error.message : 'The workbook could not be loaded.',
        );
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [adapter, initialSheet, limits, metadata, reloadToken, src]);

  const sheet = model?.sheets[selectedSheet];
  const previewClassName = ['workbook-preview', className].filter(Boolean).join(' ');
  const statusText = loading
    ? 'Loading workbook…'
    : (errorMessage ?? (model?.truncated === true ? 'Preview is bounded for this workbook.' : ''));

  return (
    <section
      aria-label={title}
      aria-busy={loading}
      className={previewClassName}
      data-preview-kind="workbook"
    >
      {showFileIdentity || model !== null ? (
        <header className="workbook-preview-header">
          <div className="workbook-preview-heading">
            <span className="workbook-preview-kind">Workbook</span>
            {showFileIdentity ? (
              <span className="workbook-preview-title">{metadata.fileName}</span>
            ) : null}
          </div>
          {model !== null && (
            <span className="workbook-preview-meta">{model.sheets.length} sheets</span>
          )}
        </header>
      ) : null}

      {statusText === '' ? null : (
        <div className="workbook-preview-status" aria-live="polite" role="status">
          {loading && (
            <SpinnerGapIcon aria-hidden="true" className="workbook-preview-spinner" size={16} />
          )}
          {!loading && errorMessage !== undefined && (
            <WarningCircleIcon aria-hidden="true" size={16} />
          )}
          <span>{statusText}</span>
          {!loading && errorMessage !== undefined && (
            <button
              className="workbook-preview-retry"
              onClick={() => setReloadToken((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {model !== null && sheet !== undefined && (
        <>
          <div aria-label="Workbook sheets" className="workbook-preview-tabs" role="tablist">
            <button
              aria-label="Previous workbook sheet"
              className="workbook-preview-tab-arrow"
              disabled={selectedSheet <= 0}
              onClick={() => setSelectedSheet((value) => Math.max(0, value - 1))}
              type="button"
            >
              <CaretLeftIcon aria-hidden="true" size={15} />
            </button>
            {model.sheets.map((candidate, index) => (
              <button
                aria-selected={selectedSheet === index}
                className="workbook-preview-tab"
                key={candidate.name}
                onClick={() => setSelectedSheet(index)}
                role="tab"
                tabIndex={selectedSheet === index ? 0 : -1}
                type="button"
              >
                {candidate.name}
              </button>
            ))}
            <button
              aria-label="Next workbook sheet"
              className="workbook-preview-tab-arrow"
              disabled={selectedSheet >= model.sheets.length - 1}
              onClick={() =>
                setSelectedSheet((value) => Math.min(model.sheets.length - 1, value + 1))
              }
              type="button"
            >
              <CaretRightIcon aria-hidden="true" size={15} />
            </button>
          </div>
          <div
            aria-label={`${sheet.name} workbook sheet`}
            className="workbook-preview-panel"
            role="tabpanel"
          >
            <div className="workbook-preview-sheet-meta">
              <span>{sheet.name}</span>
              <span>
                {sheet.rowCount.toLocaleString()} rows · {sheet.columnCount.toLocaleString()}{' '}
                columns
              </span>
            </div>
            <WorkbookSheetGrid
              maxRenderedColumns={limits.maxRenderedColumns}
              maxRenderedRows={limits.maxRenderedRows}
              sheet={sheet}
            />
          </div>
        </>
      )}
      <p className="workbook-preview-help">
        Values and formulas are displayed as inert text. Editing is disabled.
      </p>
    </section>
  );
}
