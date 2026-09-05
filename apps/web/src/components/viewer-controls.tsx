import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
import { EyeIcon } from '@phosphor-icons/react/Eye';
import { EyeSlashIcon } from '@phosphor-icons/react/EyeSlash';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './viewer-controls.css';

const PRIVATE_CONTROLS_KEY = 'shelf:private-preview-controls';
type ToolbarSlot = 'file' | 'options';
interface ViewerControlsContextValue {
  readonly visible: boolean;
  readonly slots: Record<ToolbarSlot, HTMLDivElement | null>;
}
const ViewerControlsContext = createContext<ViewerControlsContextValue | undefined>(undefined);
export const useViewerControls = () => useContext(ViewerControlsContext);

function initialVisibility(privatePreview: boolean, reveal: boolean): boolean {
  if (reveal) return true;
  if (!privatePreview || typeof window === 'undefined') return privatePreview;
  try {
    return window.sessionStorage.getItem(PRIVATE_CONTROLS_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

/** Owns viewer chrome without unmounting the content or its open panels. */
export function ViewerControls({
  children,
  actions,
  title,
  privatePreview = false,
  reveal = false,
  className = '',
}: {
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly title: string;
  readonly privatePreview?: boolean;
  readonly reveal?: boolean;
  readonly className?: string;
}) {
  const [visible, setVisible] = useState(() => initialVisibility(privatePreview, reveal));
  const [fileSlot, setFileSlot] = useState<HTMLDivElement | null>(null);
  const [optionsSlot, setOptionsSlot] = useState<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const toolbarId = useId();
  const value = useMemo(
    () => ({ visible, slots: { file: fileSlot, options: optionsSlot } }),
    [visible, fileSlot, optionsSlot],
  );

  useEffect(() => {
    if (reveal) setVisible(true);
  }, [reveal]);

  useEffect(() => {
    if (!privatePreview) return;
    try {
      window.sessionStorage.setItem(PRIVATE_CONTROLS_KEY, visible ? 'visible' : 'hidden');
    } catch {
      // Controls remain usable when browser storage is unavailable.
    }
  }, [privatePreview, visible]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[role="listbox"], [role="option"], [role="dialog"]')
      )
        return;
      if (
        event.target instanceof Node &&
        !moreRef.current?.contains(event.target) &&
        moreRef.current
      )
        moreRef.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !moreRef.current?.open) return;
      if (
        moreRef.current.querySelector('[role="dialog"]') ||
        document.querySelector('[role="listbox"]')
      )
        return;
      event.preventDefault();
      moreRef.current.open = false;
      moreRef.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  return (
    <ViewerControlsContext value={value}>
      <div className={`viewer viewer-controlled ${className}`} data-controls-visible={visible}>
        <header className="viewer-toolbar" hidden={!visible} id={toolbarId}>
          <span className="wordmark viewer-wordmark">shelf</span>
          <div className="viewer-file-slot" ref={setFileSlot} />
          <strong className="viewer-toolbar-fallback" title={title}>
            {title}
          </strong>
          <details className="viewer-more" ref={moreRef}>
            <summary aria-label="More viewer controls" title="More viewer controls">
              <DotsThreeIcon aria-hidden="true" size={24} />
              <span>More</span>
            </summary>
            <div className="viewer-more-panel">
              <div className="viewer-options-slot" ref={setOptionsSlot} />
              <div className="viewer-revision-actions">{actions}</div>
              {privatePreview ? <span className="viewer-credit">Private preview</span> : null}
            </div>
          </details>
        </header>
        <section aria-label="Viewer visibility">
          <button
            aria-controls={toolbarId}
            aria-expanded={visible}
            aria-label={visible ? 'Hide controls' : 'Show controls'}
            className="viewer-controls-toggle"
            onClick={() => {
              if (moreRef.current) moreRef.current.open = false;
              setVisible((current) => !current);
              toggleRef.current?.focus();
            }}
            ref={toggleRef}
            title={visible ? 'Hide controls' : 'Show controls'}
            type="button"
          >
            {visible ? (
              <EyeSlashIcon aria-hidden="true" size={18} />
            ) : (
              <EyeIcon aria-hidden="true" size={18} />
            )}
            <span>{visible ? 'Hide controls' : 'Show controls'}</span>
          </button>
        </section>
        {children}
      </div>
    </ViewerControlsContext>
  );
}

/** Keep controls owned by their renderer while placing them in the single viewer toolbar. */
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
