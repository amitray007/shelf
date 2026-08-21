import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

export const VIEWER_SIDEBAR_WIDTH_STORAGE_KEY = 'shelf:viewer-sidebar-width:v1';
export const VIEWER_SIDEBAR_COLLAPSED_WIDTH = 0;

export interface ViewerSidebarBounds {
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

export function viewerSidebarBounds(viewportWidth: number): ViewerSidebarBounds {
  if (viewportWidth < 1024) return { min: 260, default: 300, max: 360 };
  return { min: 280, default: 320, max: 420 };
}

export function clampViewerSidebarWidth(width: number, bounds: ViewerSidebarBounds): number {
  if (!Number.isFinite(width)) return bounds.default;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
}

// The anonymous viewer keeps its layout preference in tab-local session storage. Durable
// browser storage in the viewer graph stays confined to the audited review persistence module.
function browserSessionStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readViewerSidebarWidth(
  storage: Pick<Storage, 'getItem'> | undefined = browserSessionStorage(),
  bounds: ViewerSidebarBounds = viewerSidebarBounds(
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  ),
): number {
  try {
    const raw = storage?.getItem(VIEWER_SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw === null || raw === undefined || raw.trim() === '') return bounds.default;
    return clampViewerSidebarWidth(Number(raw), bounds);
  } catch {
    return bounds.default;
  }
}

export function writeViewerSidebarWidth(
  width: number,
  storage: Pick<Storage, 'setItem'> | undefined = browserSessionStorage(),
  bounds: ViewerSidebarBounds = viewerSidebarBounds(
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  ),
): void {
  try {
    storage?.setItem(
      VIEWER_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampViewerSidebarWidth(width, bounds)),
    );
  } catch {
    // Public viewers remain usable when storage is unavailable or restricted.
  }
}

export interface ViewerSidebarSplitProps {
  readonly sidebar: ReactNode;
  readonly content: ReactNode;
  readonly sidebarOpen: boolean;
  readonly className?: string | undefined;
}

export function ViewerSidebarSplit({
  sidebar,
  content,
  sidebarOpen,
  className,
}: ViewerSidebarSplitProps) {
  const panelRef = usePanelRef();
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  );
  const bounds = useMemo(() => viewerSidebarBounds(viewportWidth), [viewportWidth]);
  const defaultWidth = useMemo(() => readViewerSidebarWidth(undefined, bounds), [bounds]);
  const lastOpenWidthRef = useRef(defaultWidth);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const targetWidth = sidebarOpen
      ? clampViewerSidebarWidth(lastOpenWidthRef.current, bounds)
      : VIEWER_SIDEBAR_COLLAPSED_WIDTH;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.resize(targetWidth);
      if (sidebarOpen) lastOpenWidthRef.current = targetWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bounds, panelRef, sidebarOpen]);

  const rootClassName = [
    'viewer-sidebar-split',
    sidebarOpen ? 'viewer-sidebar-split-open' : 'viewer-sidebar-split-collapsed',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Group
      className={rootClassName}
      data-sidebar-collapsed={sidebarOpen ? 'false' : 'true'}
      id="viewer-sidebar-split"
      onLayoutChanged={(_, meta) => {
        if (!meta.isUserInteraction) return;
        const width = panelRef.current?.getSize().inPixels;
        if (width === undefined || !sidebarOpen) return;
        const nextWidth = clampViewerSidebarWidth(width, bounds);
        lastOpenWidthRef.current = nextWidth;
        writeViewerSidebarWidth(nextWidth, undefined, bounds);
      }}
      orientation="horizontal"
      resizeTargetMinimumSize={{ coarse: 24, fine: 16 }}
      style={{ height: '100%', width: '100%' }}
    >
      <Panel
        className="viewer-sidebar-split-sidebar"
        defaultSize={sidebarOpen ? defaultWidth : VIEWER_SIDEBAR_COLLAPSED_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        id="viewer-sidebar"
        maxSize={sidebarOpen ? bounds.max : VIEWER_SIDEBAR_COLLAPSED_WIDTH}
        minSize={sidebarOpen ? bounds.min : VIEWER_SIDEBAR_COLLAPSED_WIDTH}
        panelRef={panelRef}
      >
        {sidebar}
      </Panel>
      <Separator className="viewer-sidebar-split-separator" id="viewer-sidebar-resize">
        <span aria-hidden="true" />
      </Separator>
      <Panel
        className="viewer-sidebar-split-content"
        groupResizeBehavior="preserve-relative-size"
        id="viewer-content"
        minSize={0}
      >
        {content}
      </Panel>
    </Group>
  );
}
