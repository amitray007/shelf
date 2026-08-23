// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Office pages are keyboard-reachable scroll surfaces.

import { ArrowsInIcon } from '@phosphor-icons/react/ArrowsIn';
import { CaretLeftIcon } from '@phosphor-icons/react/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight';
import { MinusIcon } from '@phosphor-icons/react/Minus';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import { SpinnerGapIcon } from '@phosphor-icons/react/SpinnerGap';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadDocxPreviewAdapter } from './office-parser-bindings.js';
import type { PdfSource, PdfViewerAdapter } from './pdf-viewer.js';
import { PdfViewer } from './pdf-viewer.js';
import './office-document-preview.css';

/** A source is either bytes supplied by the host or a URL that is already safe to fetch. */
export type OfficeDocumentSource = ArrayBuffer | Blob | string | URL;

export interface OfficeDocumentMetadata {
  readonly fileName: string;
  readonly mediaType?: string | undefined;
  readonly byteCount?: number | undefined;
}

/**
 * The DOCX adapter returns this inert model. It deliberately has no HTML field and no event
 * handlers, so a parser can run in a worker and map its result into safe React output.
 */
export interface DocxInlineRun {
  readonly text: string;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly underline?: boolean | undefined;
  readonly code?: boolean | undefined;
}

export interface DocxBlockPosition {
  /** CSS pixels in the page coordinate system. The adapter owns unit conversion. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DocxTextBlock extends DocxBlockPosition {
  readonly kind: 'paragraph' | 'heading' | 'list-item';
  readonly runs: readonly DocxInlineRun[];
  readonly align?: 'left' | 'center' | 'right' | 'justify' | undefined;
  readonly level?: number | undefined;
}

export interface DocxTableCell {
  readonly runs: readonly DocxInlineRun[];
  readonly rowSpan?: number | undefined;
  readonly colSpan?: number | undefined;
}

export interface DocxTableBlock extends DocxBlockPosition {
  readonly kind: 'table';
  readonly rows: readonly (readonly DocxTableCell[])[];
}

export type DocxBlock = DocxTextBlock | DocxTableBlock;

export interface DocxPage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly DocxBlock[];
}

export interface DocxDocument {
  readonly pages: readonly DocxPage[];
  readonly truncated?: boolean | undefined;
}

export interface DocxPreviewLoadOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface DocxPreviewAdapter {
  /** Parse or render one DOCX source. The returned model must contain inert text only. */
  readonly load: (
    source: OfficeDocumentSource,
    metadata: OfficeDocumentMetadata,
    options?: DocxPreviewLoadOptions | undefined,
  ) => Promise<DocxDocument>;
}

/** Direct DOCX preview uses the lazy browser binding in office-parser-bindings.ts. */
export const DOCX_INTEGRATION = {
  packageName: 'docx-preview',
  version: '0.4.0',
  source: 'https://github.com/VolodymyrBaydalka/docxjs',
  note: 'Map parser output into DocxDocument before rendering; do not inject parser HTML.',
} as const;

export interface OfficePdfPreviewProps {
  /** A safe PDF source. It does not contain credentials or capability fragments. */
  readonly src: PdfSource;
  readonly title?: string | undefined;
  readonly formatLabel?: string | undefined;
  readonly adapter?: PdfViewerAdapter | undefined;
  readonly className?: string | undefined;
}

/**
 * This is a caller-supplied PDF fallback for layout-heavy office formats that have no browser
 * parser in this app. It intentionally delegates rendering and controls to the existing PdfViewer.
 */
export function OfficePdfPreview({
  adapter,
  className,
  formatLabel = 'Office layout preview',
  src,
  title = 'Office document preview',
}: OfficePdfPreviewProps) {
  return (
    <section
      aria-label={title}
      className={['office-pdf-preview', className].filter(Boolean).join(' ')}
      data-preview-kind="office-pdf"
    >
      <div className="office-pdf-preview-header">
        <span className="office-pdf-preview-kind">{formatLabel}</span>
        <span className="office-pdf-preview-note">Rendered on the server as PDF</span>
      </div>
      <PdfViewer adapter={adapter} src={src} title={title} />
    </section>
  );
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteCount(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function textRunStyle(run: DocxInlineRun): CSSProperties {
  return {
    fontFamily: run.code ? '"Geist Mono Variable", ui-monospace, monospace' : undefined,
    fontStyle: run.italic ? 'italic' : undefined,
    fontWeight: run.bold ? 650 : undefined,
    textDecoration: run.underline ? 'underline' : undefined,
    textUnderlineOffset: run.underline ? '0.16em' : undefined,
  };
}

function renderRuns(runs: readonly DocxInlineRun[]): ReactNode {
  return runs.map((run) => (
    <span
      key={`${run.text}:${run.bold === true ? 'b' : ''}${run.italic === true ? 'i' : ''}${run.underline === true ? 'u' : ''}${run.code === true ? 'c' : ''}`}
      style={textRunStyle(run)}
    >
      {run.text}
    </span>
  ));
}

function scaledPosition(position: DocxBlockPosition, scale: number): CSSProperties {
  return {
    height: finiteDimension(position.height, 20) * scale,
    left: finiteDimension(position.x, 0) * scale,
    top: finiteDimension(position.y, 0) * scale,
    width: finiteDimension(position.width, 20) * scale,
  };
}

function renderTableCell(cell: DocxTableCell): ReactNode {
  const rowSpan = Math.max(1, finiteCount(cell.rowSpan ?? 1, 1));
  const colSpan = Math.max(1, finiteCount(cell.colSpan ?? 1, 1));
  return (
    <td
      key={`${cell.runs.map((run) => run.text).join('|')}:${rowSpan}:${colSpan}`}
      colSpan={colSpan}
      rowSpan={rowSpan}
    >
      {renderRuns(cell.runs)}
    </td>
  );
}

function renderDocxBlock(block: DocxBlock, scale: number, index: number): ReactNode {
  const position = scaledPosition(block, scale);
  if (block.kind === 'table') {
    return (
      <div
        className="office-docx-block office-docx-table-block"
        key={`${block.kind}:${index}`}
        style={position}
      >
        <table>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.map((cell) => cell.runs.map((run) => run.text).join('|')).join('~')}>
                {row.map((cell) => renderTableCell(cell))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const level = Math.min(6, Math.max(1, finiteCount(block.level ?? 1, 1)));
  const textStyle: CSSProperties = {
    ...position,
    textAlign: block.align,
  };
  const className = ['office-docx-block', `office-docx-${block.kind}`].join(' ');
  const contents = (
    <>
      {block.kind === 'list-item' && (
        <span aria-hidden="true" className="office-docx-list-marker">
          •
        </span>
      )}
      <span className="office-docx-block-text">{renderRuns(block.runs)}</span>
    </>
  );
  if (block.kind === 'heading') {
    return (
      <h2
        className={className}
        data-heading-level={level}
        key={`${block.kind}:${index}`}
        style={textStyle}
      >
        {contents}
      </h2>
    );
  }
  return (
    <div className={className} key={`${block.kind}:${index}`} style={textStyle}>
      {contents}
    </div>
  );
}

export function DocxPageCanvas({
  page,
  scale = 1,
}: {
  readonly page: DocxPage;
  readonly scale?: number | undefined;
}) {
  const safeScale = clampZoom(scale);
  return (
    <div
      className="office-docx-page"
      data-safe-output="text-model"
      style={{
        height: finiteDimension(page.height, 1056) * safeScale,
        width: finiteDimension(page.width, 816) * safeScale,
      }}
    >
      {page.blocks.map((block, index) => renderDocxBlock(block, safeScale, index))}
    </div>
  );
}

function DocxIconButton({
  children,
  disabled = false,
  label,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="office-docx-button"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export interface DocxPreviewProps {
  readonly src: OfficeDocumentSource;
  readonly metadata: OfficeDocumentMetadata;
  readonly adapter?: DocxPreviewAdapter | undefined;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
  readonly initialFitWidth?: boolean | undefined;
  readonly initialZoom?: number | undefined;
}

export function DocxPreview({
  adapter,
  className,
  initialFitWidth = true,
  initialZoom = 1,
  metadata,
  src,
  title = 'DOCX preview',
}: DocxPreviewProps) {
  const pageShellRef = useRef<HTMLDivElement | null>(null);
  const [document, setDocument] = useState<DocxDocument | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [fitWidth, setFitWidth] = useState(initialFitWidth);
  const [zoom, setZoom] = useState(clampZoom(initialZoom));
  const [fitScale, setFitScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void reloadToken;
    setDocument(null);
    setPageNumber(1);
    setErrorMessage(undefined);
    setLoading(true);
    const adapterPromise =
      adapter === undefined ? loadDocxPreviewAdapter() : Promise.resolve(adapter);
    void adapterPromise
      .then((resolvedAdapter) => resolvedAdapter.load(src, metadata, { signal: controller.signal }))
      .then((nextDocument) => {
        if (disposed) return;
        if (nextDocument.pages.length === 0) {
          setErrorMessage('The DOCX adapter returned no pages.');
          setLoading(false);
          return;
        }
        setDocument(nextDocument);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setLoading(false);
        setErrorMessage(error instanceof Error ? error.message : 'The DOCX could not be loaded.');
      });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [adapter, metadata, reloadToken, src]);

  const page = document?.pages[pageNumber - 1];
  const pageWidth = finiteDimension(page?.width ?? 816, 816);

  const updateFitScale = useCallback(() => {
    const shell = pageShellRef.current;
    if (shell === null || page === undefined) return;
    setFitScale(clampZoom((shell.clientWidth - 32) / pageWidth));
  }, [page, pageWidth]);

  useEffect(() => {
    if (!fitWidth || page === undefined) return;
    updateFitScale();
    const shell = pageShellRef.current;
    if (shell === null) return;
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateFitScale);
      observer.observe(shell);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateFitScale);
    return () => window.removeEventListener('resize', updateFitScale);
  }, [fitWidth, page, updateFitScale]);

  const scale = clampZoom(fitWidth ? fitScale : zoom);
  const goToPage = (nextPage: number) => {
    const count = document?.pages.length ?? 0;
    if (count === 0) return;
    setPageNumber(Math.min(count, Math.max(1, nextPage)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'PageDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      goToPage(pageNumber + 1);
    } else if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      goToPage(pageNumber - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      goToPage(1);
    } else if (event.key === 'End') {
      event.preventDefault();
      goToPage(document?.pages.length ?? 1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setFitWidth(false);
      setZoom((value) => clampZoom(value + ZOOM_STEP));
    } else if (event.key === '-') {
      event.preventDefault();
      setFitWidth(false);
      setZoom((value) => clampZoom(value - ZOOM_STEP));
    } else if (event.key === '0') {
      event.preventDefault();
      setFitWidth(true);
    }
  };

  const count = document?.pages.length ?? 0;
  const viewerClassName = ['office-docx-preview', className].filter(Boolean).join(' ');
  const status = useMemo<string | undefined>(() => {
    if (loading) return 'Loading DOCX…';
    if (errorMessage !== undefined) return errorMessage;
    if (page === undefined) return 'No page selected.';
    return undefined;
  }, [errorMessage, loading, page]);

  return (
    <section
      aria-label={title}
      aria-busy={loading}
      className={viewerClassName}
      data-preview-kind="docx"
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <header className="office-docx-toolbar">
        <div className="office-docx-page-controls">
          <DocxIconButton
            disabled={loading || pageNumber <= 1}
            label="Previous DOCX page"
            onClick={() => goToPage(pageNumber - 1)}
          >
            <CaretLeftIcon aria-hidden="true" size={17} />
          </DocxIconButton>
          <label className="office-docx-page-input">
            <span className="office-docx-visually-hidden">Current DOCX page</span>
            <input
              aria-label="Current DOCX page"
              disabled={loading || count === 0}
              inputMode="numeric"
              max={count || undefined}
              min={1}
              onChange={(event) => {
                const nextPage = Number(event.currentTarget.value);
                if (Number.isFinite(nextPage)) goToPage(nextPage);
              }}
              type="number"
              value={count === 0 ? '' : pageNumber}
            />
            <span aria-hidden="true">/ {count || '—'}</span>
          </label>
          <DocxIconButton
            disabled={loading || count === 0 || pageNumber >= count}
            label="Next DOCX page"
            onClick={() => goToPage(pageNumber + 1)}
          >
            <CaretRightIcon aria-hidden="true" size={17} />
          </DocxIconButton>
        </div>

        <div className="office-docx-zoom-controls">
          <DocxIconButton
            disabled={scale <= MIN_ZOOM}
            label="Zoom out DOCX"
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => clampZoom(value - ZOOM_STEP));
            }}
          >
            <MinusIcon aria-hidden="true" size={16} />
          </DocxIconButton>
          <output aria-label="DOCX zoom" className="office-docx-zoom-label">
            {Math.round(scale * 100)}%
          </output>
          <DocxIconButton
            disabled={scale >= MAX_ZOOM}
            label="Zoom in DOCX"
            onClick={() => {
              setFitWidth(false);
              setZoom((value) => clampZoom(value + ZOOM_STEP));
            }}
          >
            <PlusIcon aria-hidden="true" size={16} />
          </DocxIconButton>
          <DocxIconButton
            disabled={loading || count === 0}
            label="Fit DOCX page to width"
            onClick={() => setFitWidth(true)}
          >
            <ArrowsInIcon aria-hidden="true" size={16} />
          </DocxIconButton>
        </div>
      </header>

      {status !== undefined && (
        <div className="office-docx-status" aria-live="polite" role="status">
          {loading && (
            <SpinnerGapIcon aria-hidden="true" className="office-docx-spinner" size={16} />
          )}
          {!loading && errorMessage !== undefined && (
            <WarningCircleIcon aria-hidden="true" size={16} />
          )}
          <span>{status}</span>
          {!loading && errorMessage !== undefined && (
            <button
              className="office-docx-retry"
              onClick={() => setReloadToken((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
          )}
        </div>
      )}
      {!loading && errorMessage === undefined && document?.truncated === true && (
        <p className="office-docx-bounded-note">
          Bounded preview: some document content was omitted.
        </p>
      )}

      <section aria-label={`${title} pages`} className="office-docx-page-shell" ref={pageShellRef}>
        {page !== undefined && <DocxPageCanvas page={page} scale={scale} />}
      </section>
      <p className="office-docx-help">
        Use Page Up and Page Down to change pages. Use + and − to zoom.
      </p>
    </section>
  );
}
