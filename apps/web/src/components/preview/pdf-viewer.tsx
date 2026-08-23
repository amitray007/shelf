// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The PDF surface exposes keyboard shortcuts from its focusable region.

import { ArrowsInIcon } from '@phosphor-icons/react/ArrowsIn';
import { CaretLeftIcon } from '@phosphor-icons/react/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/CaretRight';
import { MinusIcon } from '@phosphor-icons/react/Minus';
import { PlusIcon } from '@phosphor-icons/react/Plus';
import { SpinnerGapIcon } from '@phosphor-icons/react/SpinnerGap';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import './pdf-viewer.css';

/**
 * The integrator must add `pdfjs-dist@6.2.108` to `apps/web` and configure its
 * local worker before creating this adapter. The Vite setup is:
 *
 * ```ts
 * import * as pdfjsLib from 'pdfjs-dist';
 * import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
 * pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
 * const adapter = createPdfJsAdapter(pdfjsLib);
 * ```
 *
 * Do not use a CDN worker. `getDocument({ url, disableStream: false,
 * disableAutoFetch: false, rangeChunkSize })` keeps safe remote preview URLs
 * eligible for HTTP range requests.
 */
export const PDF_JS_INTEGRATION = {
  packageName: 'pdfjs-dist',
  version: '6.2.108',
  workerImport: 'pdfjs-dist/build/pdf.worker.min.mjs?url',
  documentApi:
    'getDocument({ url, disableStream: false, disableAutoFetch: false, rangeChunkSize })',
} as const;

export type PdfSource = string | URL | Uint8Array;

export interface PdfDocumentOptions {
  readonly disableAutoFetch?: boolean;
  readonly disableStream?: boolean;
  readonly rangeChunkSize?: number;
}

export interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

export interface PdfRenderTask {
  readonly promise: Promise<void>;
  readonly cancel?: (() => void) | undefined;
}

export interface PdfPage {
  readonly getViewport: (options: { readonly scale: number }) => PdfViewport;
  readonly render: (options: {
    readonly canvasContext: CanvasRenderingContext2D;
    readonly viewport: PdfViewport;
  }) => PdfRenderTask;
}

export interface PdfDocument {
  readonly numPages: number;
  readonly getPage: (pageNumber: number) => Promise<PdfPage>;
  readonly cleanup?: (() => void) | undefined;
  readonly destroy?: (() => Promise<void> | void) | undefined;
}

export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  readonly destroy?: (() => Promise<void> | void) | undefined;
}

export interface PdfViewerAdapter {
  readonly getDocument: (source: PdfSource, options?: PdfDocumentOptions) => PdfLoadingTask;
}

export interface PdfJsModule {
  readonly getDocument: (source: {
    readonly data?: Uint8Array;
    readonly disableAutoFetch: boolean;
    readonly disableStream: boolean;
    readonly rangeChunkSize: number;
    readonly url?: string;
  }) => PdfLoadingTask;
}

export function createPdfJsAdapter(pdfjs: PdfJsModule): PdfViewerAdapter {
  return {
    getDocument: (source, options = {}) => {
      const input =
        typeof source === 'string' || source instanceof URL
          ? { url: String(source) }
          : { data: source };
      return pdfjs.getDocument({
        ...input,
        disableAutoFetch: options.disableAutoFetch ?? false,
        disableStream: options.disableStream ?? false,
        rangeChunkSize: options.rangeChunkSize ?? 65_536,
      });
    },
  };
}

export interface PdfViewerProps {
  /** A safe URL or byte source. The viewer never adds credentials or capabilities. */
  readonly src: PdfSource;
  readonly title?: string | undefined;
  readonly adapter?: PdfViewerAdapter | undefined;
  readonly className?: string | undefined;
  readonly initialFitWidth?: boolean | undefined;
  readonly initialZoom?: number | undefined;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function sourceKey(source: PdfSource): string | Uint8Array {
  if (typeof source === 'string') return source;
  if (source instanceof URL) return source.href;
  return source;
}

function isCancelledRender(error: unknown): boolean {
  return error instanceof Error && /cancel/i.test(error.message);
}

function PdfIconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className="pdf-viewer-button"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export function PdfViewer({
  src,
  title = 'PDF preview',
  adapter,
  className,
  initialFitWidth = true,
  initialZoom = 1,
}: PdfViewerProps) {
  const pageShellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const documentRef = useRef<PdfDocument | null>(null);
  const loadingTaskRef = useRef<PdfLoadingTask | null>(null);
  const renderTaskRef = useRef<PdfRenderTask | null>(null);
  const renderVersionRef = useRef(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [fitWidth, setFitWidth] = useState(initialFitWidth);
  const [zoom, setZoom] = useState(clampZoom(initialZoom));
  const [renderedZoom, setRenderedZoom] = useState(clampZoom(initialZoom));
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [reloadToken, setReloadToken] = useState(0);

  const sourceValue = sourceKey(src);

  useEffect(() => {
    let disposed = false;
    void reloadToken;
    const previousDocument = documentRef.current;
    documentRef.current = null;
    if (previousDocument?.destroy !== undefined) void previousDocument.destroy();
    if (adapter === undefined) {
      setLoading(false);
      setErrorMessage('PDF.js is not configured for this viewer.');
      setPageCount(0);
      return () => {
        disposed = true;
      };
    }

    setLoading(true);
    setErrorMessage(undefined);
    setPageCount(0);
    setPageNumber(1);
    const loadingTask = adapter.getDocument(sourceValue, {
      disableAutoFetch: false,
      disableStream: false,
      rangeChunkSize: 65_536,
    });
    loadingTaskRef.current = loadingTask;
    void loadingTask.promise
      .then((document) => {
        if (disposed) {
          if (document.destroy !== undefined) void document.destroy();
          return;
        }
        documentRef.current = document;
        setPageCount(document.numPages);
        setPageNumber(1);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setLoading(false);
        setErrorMessage(error instanceof Error ? error.message : 'The PDF could not be loaded.');
      });

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel?.();
      renderTaskRef.current = null;
      if (loadingTaskRef.current === loadingTask) {
        loadingTaskRef.current = null;
        void loadingTask.destroy?.();
      }
    };
  }, [adapter, reloadToken, sourceValue]);

  const renderPage = useCallback(async () => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    const pageShell = pageShellRef.current;
    if (document === null || canvas === null || pageShell === null || pageNumber < 1) return;

    const renderVersion = renderVersionRef.current + 1;
    renderVersionRef.current = renderVersion;
    renderTaskRef.current?.cancel?.();
    renderTaskRef.current = null;
    setRendering(true);
    try {
      const page = await document.getPage(pageNumber);
      if (renderVersion !== renderVersionRef.current) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(pageShell.clientWidth - 32, 240);
      const nextZoom = fitWidth
        ? clampZoom(availableWidth / Math.max(baseViewport.width, 1))
        : clampZoom(zoom);
      const viewport = page.getViewport({ scale: nextZoom });
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('The browser could not create a PDF canvas.');

      const pixelRatio = typeof window === 'undefined' ? 1 : Math.max(window.devicePixelRatio, 1);
      canvas.width = Math.ceil(viewport.width * pixelRatio);
      canvas.height = Math.ceil(viewport.height * pixelRatio);
      canvas.style.width = `${Math.ceil(viewport.width)}px`;
      canvas.style.height = `${Math.ceil(viewport.height)}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const renderTask = page.render({ canvasContext: context, viewport });
      renderTaskRef.current = renderTask;
      setRenderedZoom(nextZoom);
      await renderTask.promise;
      if (renderVersion !== renderVersionRef.current) return;
    } catch (error: unknown) {
      if (!isCancelledRender(error)) {
        setErrorMessage(
          error instanceof Error ? error.message : 'The PDF page could not be rendered.',
        );
      }
    } finally {
      if (renderVersion === renderVersionRef.current) setRendering(false);
    }
  }, [fitWidth, pageNumber, zoom]);

  useEffect(() => {
    if (loading || errorMessage !== undefined || pageCount === 0) return;
    void renderPage();
    return () => renderTaskRef.current?.cancel?.();
  }, [errorMessage, loading, pageCount, renderPage]);

  useEffect(() => {
    const shell = pageShellRef.current;
    if (shell === null) return;
    const onResize = () => {
      if (fitWidth) void renderPage();
    };
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(onResize);
      observer.observe(shell);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitWidth, renderPage]);

  const goToPage = (nextPage: number) => {
    if (pageCount === 0) return;
    setPageNumber(Math.min(pageCount, Math.max(1, nextPage)));
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
      goToPage(pageCount);
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

  const viewerClassName = ['pdf-viewer', className].filter(Boolean).join(' ');
  const pageStatus = pageCount > 0 ? `Page ${pageNumber} of ${pageCount}` : 'No pages';
  const currentZoom = fitWidth ? renderedZoom : zoom;

  return (
    <section
      aria-label={title}
      aria-busy={loading || rendering}
      className={viewerClassName}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <header className="pdf-viewer-toolbar">
        <div className="pdf-viewer-page-controls">
          <PdfIconButton
            disabled={loading || pageNumber <= 1}
            label="Previous PDF page"
            onClick={() => goToPage(pageNumber - 1)}
          >
            <CaretLeftIcon aria-hidden="true" size={17} />
          </PdfIconButton>
          <label className="pdf-viewer-page-input">
            <span className="pdf-viewer-visually-hidden">Current PDF page</span>
            <input
              aria-label="Current PDF page"
              disabled={loading || pageCount === 0}
              inputMode="numeric"
              max={pageCount || undefined}
              min={1}
              onChange={(event) => {
                const nextPage = Number(event.currentTarget.value);
                if (Number.isFinite(nextPage)) goToPage(nextPage);
              }}
              type="number"
              value={pageCount === 0 ? '' : pageNumber}
            />
            <span aria-hidden="true">/ {pageCount || '—'}</span>
          </label>
          <PdfIconButton
            disabled={loading || pageCount === 0 || pageNumber >= pageCount}
            label="Next PDF page"
            onClick={() => goToPage(pageNumber + 1)}
          >
            <CaretRightIcon aria-hidden="true" size={17} />
          </PdfIconButton>
        </div>

        <div className="pdf-viewer-zoom-controls">
          <PdfIconButton
            disabled={currentZoom <= MIN_ZOOM}
            label="Zoom out PDF"
            onClick={() => {
              setZoom(clampZoom(currentZoom - ZOOM_STEP));
              setFitWidth(false);
            }}
          >
            <MinusIcon aria-hidden="true" size={16} />
          </PdfIconButton>
          <output aria-label="PDF zoom" className="pdf-viewer-zoom-label">
            {Math.round(currentZoom * 100)}%
          </output>
          <PdfIconButton
            disabled={currentZoom >= MAX_ZOOM}
            label="Zoom in PDF"
            onClick={() => {
              setZoom(clampZoom(currentZoom + ZOOM_STEP));
              setFitWidth(false);
            }}
          >
            <PlusIcon aria-hidden="true" size={16} />
          </PdfIconButton>
          <PdfIconButton
            disabled={loading || pageCount === 0}
            label="Fit PDF page to width"
            onClick={() => setFitWidth(true)}
          >
            <ArrowsInIcon aria-hidden="true" size={16} />
          </PdfIconButton>
        </div>
      </header>

      <div className="pdf-viewer-status" aria-live="polite" role="status">
        {loading && (
          <>
            <SpinnerGapIcon aria-hidden="true" className="pdf-viewer-spinner" size={16} />
            <span>Loading PDF…</span>
          </>
        )}
        {!loading && errorMessage !== undefined && (
          <>
            <WarningCircleIcon aria-hidden="true" size={16} />
            <span>{errorMessage}</span>
            <button
              className="pdf-viewer-retry"
              onClick={() => setReloadToken((value) => value + 1)}
              type="button"
            >
              Try again
            </button>
          </>
        )}
        {!loading && errorMessage === undefined && rendering && <span>Rendering page…</span>}
      </div>

      <div className="pdf-viewer-page-status" aria-live="polite">
        {pageStatus}
      </div>
      <div className="pdf-viewer-page-shell" ref={pageShellRef}>
        <canvas
          aria-label={`${pageStatus} of ${title}`}
          className="pdf-viewer-canvas"
          ref={canvasRef}
          role="img"
        />
      </div>
      <p className="pdf-viewer-help">
        Use Page Up and Page Down to change pages. Use + and − to zoom.
      </p>
      <div
        aria-hidden="true"
        className="pdf-viewer-measure"
        style={{ '--pdf-rendered-zoom': renderedZoom } as CSSProperties}
      />
    </section>
  );
}
