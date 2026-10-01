import { ChatCircleIcon } from '@phosphor-icons/react/ChatCircle';
import { FileTextIcon } from '@phosphor-icons/react/FileText';
import { FolderSimpleIcon } from '@phosphor-icons/react/FolderSimple';
import { XIcon } from '@phosphor-icons/react/X';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from './format.js';
import './viewer-controls.css';

type ToolbarSlot =
  | 'file'
  | 'view'
  | 'download'
  | 'options'
  | 'document'
  | 'navigation'
  | 'technical';
interface ViewerControlsContextValue {
  readonly slots: Record<ToolbarSlot, HTMLDivElement | null>;
  readonly sidebarCloser: RefObject<(() => void) | null>;
  readonly activateSidebar: () => void;
}
const ViewerControlsContext = createContext<ViewerControlsContextValue | undefined>(undefined);
export const useViewerControls = () => useContext(ViewerControlsContext);

export interface ViewerRevisionDetails {
  readonly revisionNumber: number;
  readonly createdAt: string;
  readonly byteCount: number;
  readonly fileCount?: number | undefined;
  readonly contentHash?: string | undefined;
}

export function metadataLabel(key: string): string {
  const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Floating viewer tools stay mounted, so closing them never resets a renderer. */
export function ViewerControls({
  children,
  actions,
  title,
  metadata = {},
  revision,
  privatePreview = false,
  className = '',
}: {
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly title: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly revision?: ViewerRevisionDetails | undefined;
  readonly privatePreview?: boolean;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'details' | 'actions'>('details');
  const [fileSlot, setFileSlot] = useState<HTMLDivElement | null>(null);
  const [viewSlot, setViewSlot] = useState<HTMLDivElement | null>(null);
  const [downloadSlot, setDownloadSlot] = useState<HTMLDivElement | null>(null);
  const [optionsSlot, setOptionsSlot] = useState<HTMLDivElement | null>(null);
  const [documentSlot, setDocumentSlot] = useState<HTMLDivElement | null>(null);
  const [navigationSlot, setNavigationSlot] = useState<HTMLDivElement | null>(null);
  const [technicalSlot, setTechnicalSlot] = useState<HTMLDivElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const sidebarCloser = useRef<(() => void) | null>(null);
  const activateSidebar = useCallback(() => {
    if (window.innerWidth <= 640) setOpen(false);
  }, []);
  const value = useMemo(
    () => ({
      sidebarCloser,
      activateSidebar,
      slots: {
        file: fileSlot,
        view: viewSlot,
        download: downloadSlot,
        options: optionsSlot,
        document: documentSlot,
        navigation: navigationSlot,
        technical: technicalSlot,
      },
    }),
    [
      fileSlot,
      viewSlot,
      downloadSlot,
      optionsSlot,
      documentSlot,
      navigationSlot,
      technicalSlot,
      activateSidebar,
    ],
  );
  const fields = Object.entries(metadata).filter(
    ([key]) => key !== 'title' && key !== 'description',
  );
  const close = () => {
    setOpen(false);
    launcherRef.current?.focus();
  };

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Nested renderer settings, menus, and selects own the first Escape.
      if (
        document.querySelector(
          '[role="listbox"], [role="menu"], [data-base-ui-portal] [role="dialog"]',
        )
      )
        return;
      if (panelRef.current?.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setOpen(false);
      launcherRef.current?.focus();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <ViewerControlsContext value={value}>
      <div className={`viewer viewer-controlled ${className}`}>
        {children}
        <nav aria-label="Viewer sidebar" className="viewer-navigation-launchers">
          <div ref={setNavigationSlot} />
        </nav>
        <div
          aria-labelledby={`${id}-heading`}
          className="viewer-details-window"
          hidden={!open}
          id={id}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="viewer-details-header">
            <span aria-hidden="true" className="shelf-brand-mark" />
            <h2 id={`${id}-heading`}>Artifact details</h2>
            <button
              aria-label="Close artifact details"
              className="viewer-panel-close"
              onClick={close}
              ref={closeRef}
              type="button"
            >
              <XIcon aria-hidden="true" size={18} />
            </button>
          </div>
          <div
            aria-label="Artifact panel"
            className="viewer-details-tabs"
            role="tablist"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 'details'
                  : event.key === 'End'
                    ? 'actions'
                    : tab === 'details'
                      ? 'actions'
                      : 'details';
              setTab(next);
              document.getElementById(`${id}-${next}-tab`)?.focus();
            }}
          >
            <button
              aria-controls={`${id}-details`}
              aria-selected={tab === 'details'}
              id={`${id}-details-tab`}
              tabIndex={tab === 'details' ? 0 : -1}
              onClick={() => setTab('details')}
              role="tab"
              type="button"
            >
              Details
            </button>
            <button
              aria-controls={`${id}-actions`}
              aria-selected={tab === 'actions'}
              id={`${id}-actions-tab`}
              tabIndex={tab === 'actions' ? 0 : -1}
              onClick={() => setTab('actions')}
              role="tab"
              type="button"
            >
              View &amp; actions
            </button>
          </div>
          <div
            aria-labelledby={`${id}-details-tab`}
            className="viewer-details-body"
            hidden={tab !== 'details'}
            id={`${id}-details`}
            role="tabpanel"
          >
            <section className="viewer-details-intro">
              <h3>{title}</h3>
              {metadata.description?.trim() ? <p>{metadata.description}</p> : null}
              {revision ? (
                <div className="viewer-details-summary">
                  <span>Revision {revision.revisionNumber}</span>
                  <time dateTime={revision.createdAt}>
                    {new Date(revision.createdAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </time>
                </div>
              ) : null}
            </section>
            {fields.length > 0 ? (
              <section className="viewer-details-section" aria-label="Publisher metadata">
                <h3>Publisher metadata</h3>
                <dl className="viewer-metadata-list">
                  {fields.map(([key, fieldValue]) => (
                    <div key={key}>
                      <dt title={key}>{metadataLabel(key)}</dt>
                      <dd>{fieldValue || 'Empty'}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}
            <div className="viewer-document-slot" ref={setDocumentSlot} />
            <section
              className="viewer-details-section viewer-file-information"
              aria-label="File information"
            >
              <h3>File information</h3>
              <div ref={setTechnicalSlot} />
              {revision ? (
                <dl className="viewer-metadata-list">
                  <div>
                    <dt>{revision.fileCount === undefined ? 'Size' : 'Total size'}</dt>
                    <dd>{formatBytes(revision.byteCount)}</dd>
                  </div>
                  {revision.fileCount === undefined ? null : (
                    <div>
                      <dt>Files</dt>
                      <dd>{revision.fileCount}</dd>
                    </div>
                  )}
                  {revision.contentHash ? (
                    <div>
                      <dt>Checksum</dt>
                      <dd className="viewer-metadata-code">{revision.contentHash}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </section>
          </div>
          <div
            aria-labelledby={`${id}-actions-tab`}
            className="viewer-details-body viewer-actions-body"
            hidden={tab !== 'actions'}
            id={`${id}-actions`}
            role="tabpanel"
          >
            <div className="viewer-selected-file">
              <span className="viewer-file-symbol">
                <FileTextIcon aria-hidden="true" size={22} />
              </span>
              <div className="viewer-file-slot" ref={setFileSlot} />
            </div>
            <section className="viewer-action-section viewer-display-section">
              <h3>Display</h3>
              <div className="viewer-view-slot" ref={setViewSlot} />
            </section>
            <section className="viewer-action-section viewer-renderer-section">
              <h3>Display options</h3>
              <div className="viewer-options-slot preview-component" ref={setOptionsSlot} />
            </section>
            <section className="viewer-action-section">
              <h3>Revision</h3>
              <div className="viewer-revision-actions">{actions}</div>
            </section>
            <div className="viewer-download-slot" ref={setDownloadSlot} />
          </div>
          {privatePreview ? <div className="viewer-details-footer">Private preview</div> : null}
        </div>
        <button
          aria-controls={id}
          aria-expanded={open}
          aria-label="Open artifact details"
          className="viewer-launcher"
          onClick={() => {
            if (open) close();
            else {
              if (window.innerWidth <= 640) sidebarCloser.current?.();
              setOpen(true);
            }
          }}
          ref={launcherRef}
          type="button"
        >
          <span aria-hidden="true" className="shelf-brand-mark" />
          <span>Details</span>
        </button>
      </div>
    </ViewerControlsContext>
  );
}

/** Renderer-owned actions keep their state while their portal target stays mounted. */
export function ViewerToolbarContent({
  children,
  slot = 'options',
}: {
  readonly children: ReactNode;
  readonly slot?: ToolbarSlot;
}) {
  const controls = useViewerControls();
  if (controls === undefined) return children;
  const target = controls.slots[slot];
  return target === null ? null : createPortal(children, target);
}

export function ViewerSidebarLauncher({
  open,
  files = false,
  discussion = false,
  mode = 'tree',
  controlsId,
  onToggle,
  onModeChange,
}: {
  readonly open: boolean;
  readonly files?: boolean;
  readonly discussion?: boolean;
  readonly mode?: 'tree' | 'discussion';
  readonly controlsId: string;
  readonly onToggle: () => void;
  readonly onModeChange?: ((mode: 'tree' | 'discussion') => void) | undefined;
}) {
  const controls = useViewerControls();
  const sidebarCloser = controls?.sidebarCloser;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sidebarCloser) return;
    const closer = open ? onToggle : null;
    sidebarCloser.current = closer;
    return () => {
      if (sidebarCloser.current === closer) sidebarCloser.current = null;
    };
  }, [open, onToggle, sidebarCloser]);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open && !document.querySelector('.viewer-details-window:not([hidden])'))
      ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  return (
    <ViewerToolbarContent slot="navigation">
      <div className="viewer-sidebar-launcher-group" ref={ref}>
        {[
          {
            enabled: files,
            value: 'tree' as const,
            label: 'files sidebar',
            text: 'Files',
            icon: FolderSimpleIcon,
          },
          {
            enabled: discussion,
            value: 'discussion' as const,
            label: 'discussion',
            text: 'Discussion',
            icon: ChatCircleIcon,
          },
        ]
          .filter((item) => item.enabled)
          .map((item) => {
            const active = open && (!files || !discussion || mode === item.value);
            return (
              <button
                aria-controls={controlsId}
                aria-expanded={active}
                aria-label={`${active ? 'Collapse' : 'Open'} ${item.label}`}
                key={item.value}
                onClick={() => {
                  if (!active) {
                    controls?.activateSidebar();
                    onModeChange?.(item.value);
                  }
                  if (!open || active) onToggle();
                }}
                type="button"
              >
                <item.icon aria-hidden="true" size={18} />
                <span>{item.text}</span>
              </button>
            );
          })}
      </div>
    </ViewerToolbarContent>
  );
}
