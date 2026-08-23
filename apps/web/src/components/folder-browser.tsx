// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import type { FileTreeDirectoryHandle } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { CommentAnchor, CommentThread, FolderEntry } from '@shelf/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ViewerAuthority } from '../api.js';
import {
  requiresClientBytes,
  selectRenderer,
  supportsSourceView,
  usesPreviewUrl,
} from '../rendering.js';
import type { FolderShareResolution } from '../share-types.js';
import { type ArtifactFileContent, ArtifactFileView } from './artifact-file-view.js';
import { viewerSessionStorageKey } from './file-view.js';
import { RendererFrame } from './renderer-frame.js';
import { DiscussionPanel } from './review/discussion-panel.js';
import { ReviewSidebarToolbar } from './review/sidebar-toolbar.js';
import type { ReviewSidebarMode, ReviewThreadFilter } from './review/types.js';
import { ViewerSidebarSplit } from './viewer-sidebar-split.js';

export interface FolderBrowserReview {
  readonly moderator?: boolean | undefined;
  readonly canCreateThread: boolean;
  readonly revisionId: string;
  readonly threads: readonly CommentThread[];
  readonly activeThreadId?: string | undefined;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly loading?: boolean | undefined;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly mode: ReviewSidebarMode;
  readonly sidebarOpen?: boolean | undefined;
  readonly onSidebarToggle?: (() => void) | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly onModeChange: (mode: ReviewSidebarMode) => void;
  readonly onSelectFile?: ((path: string) => void) | undefined;
  readonly onSelectThread: (threadId: string) => void;
  readonly onNavigateToThread?: ((threadId: string) => void) | undefined;
  readonly onCreateThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onSetThreadStatus: (threadId: string, status: 'resolve' | 'reopen') => Promise<void>;
  readonly onModeratePost?:
    | ((postId: string, moderation: 'hide' | 'unhide') => Promise<void>)
    | undefined;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
}

interface FolderBrowserProps {
  readonly authority?: ViewerAuthority | undefined;
  readonly entries: readonly FolderEntry[];
  readonly loadFile: (path: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  readonly loadPreviewUrl?: ((path: string) => string) | undefined;
  readonly downloadFile?: ((path: string) => void) | undefined;
  readonly rendererOrigin?: string | undefined;
  readonly resolution?: FolderShareResolution | undefined;
  readonly review?: FolderBrowserReview | undefined;
  readonly navigation?: FolderBrowserNavigation | undefined;
}

export interface FolderBrowserNavigation {
  readonly sidebarOpen: boolean;
  readonly onSidebarToggle: () => void;
  readonly sidebarControlsId?: string | undefined;
}

function readExpandedTreePaths(paths: readonly string[]): readonly string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(viewerSessionStorageKey('folder-tree')) ?? 'null',
    );
    if (!Array.isArray(parsed)) return null;
    const available = new Set(paths.filter((path) => path.endsWith('/')));
    return parsed.filter((path): path is string => typeof path === 'string' && available.has(path));
  } catch {
    return null;
  }
}

function readSelectedFilePath(filePaths: ReadonlySet<string>): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const value = window.sessionStorage.getItem(viewerSessionStorageKey('folder-selected-file'));
    return value !== null && filePaths.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function expandedTreePaths(
  paths: readonly string[],
  model: ReturnType<typeof useFileTree>['model'],
) {
  return paths.filter((path) => {
    const item = model.getItem(path);
    const directory = item?.isDirectory() === true ? (item as FileTreeDirectoryHandle) : undefined;
    return directory?.isExpanded() === true;
  });
}

function ancestorDirectories(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

export function isFolderEntryVisible(path: string, collapsedDirectories: ReadonlySet<string>) {
  return ancestorDirectories(path).every((directory) => !collapsedDirectories.has(directory));
}

export function folderFileViewKey(path: string | undefined, loading: boolean): string {
  return `${path ?? 'empty'}:${loading ? 'loading' : 'loaded'}`;
}

export function shouldApplyFolderFocusRequest(
  requestId: number | undefined,
  consumedRequestId: number | undefined,
): boolean {
  return requestId !== undefined && requestId !== consumedRequestId;
}

export function isProgrammaticFolderSelection(
  selectedPath: string,
  programmaticPath: string | undefined,
): boolean {
  return selectedPath === programmaticPath;
}

export function FolderBrowser({
  authority,
  entries,
  loadFile,
  loadPreviewUrl,
  downloadFile,
  navigation,
  rendererOrigin,
  resolution,
  review,
}: FolderBrowserProps) {
  const { fileEntriesByPath, filePaths, firstFile, paths } = useMemo(() => {
    const nextPaths: string[] = [];
    const nextFilePaths = new Set<string>();
    const nextFileEntriesByPath = new Map<string, Extract<FolderEntry, { kind: 'file' }>>();
    let nextFirstFile: Extract<FolderEntry, { kind: 'file' }> | undefined;
    for (const entry of entries) {
      nextPaths.push(entry.kind === 'directory' ? `${entry.path}/` : entry.path);
      if (entry.kind !== 'file') continue;
      nextFirstFile ??= entry;
      nextFilePaths.add(entry.path);
      nextFileEntriesByPath.set(entry.path, entry);
    }
    return {
      fileEntriesByPath: nextFileEntriesByPath,
      filePaths: nextFilePaths,
      firstFile: nextFirstFile,
      paths: nextPaths,
    };
  }, [entries]);
  const filePathsRef = useRef(filePaths);
  filePathsRef.current = filePaths;
  const focusRequestId = review?.focusRequestId;
  const consumedFocusRequestIdRef = useRef<number | undefined>(undefined);
  const onSelectFileRef = useRef(review?.onSelectFile);
  onSelectFileRef.current = review?.onSelectFile;
  const programmaticSelectionPathRef = useRef<string | undefined>(undefined);
  const treeMountedRef = useRef(false);
  const [selectedPath, setSelectedPath] = useState(
    () => readSelectedFilePath(filePaths) ?? firstFile?.path,
  );
  const selected = selectedPath === undefined ? undefined : fileEntriesByPath.get(selectedPath);
  const [loadedFile, setLoadedFile] = useState<{
    readonly path?: string | undefined;
    readonly content: ArtifactFileContent;
  }>(() => {
    if (selected === undefined) return { content: { status: 'loading' } };
    const renderer = selectRenderer(selected.mediaType, rendererOrigin, selected.path);
    const immediatelyReady =
      renderer.kind === 'download' && !supportsSourceView(selected.mediaType, selected.path);
    return {
      path: selected.path,
      content: { status: immediatelyReady ? 'ready' : 'loading' },
    };
  });
  const [treeSearchOpen, setTreeSearchOpen] = useState(false);
  const [discussionSearchOpen, setDiscussionSearchOpen] = useState(false);
  const [threadFilter, setThreadFilter] = useState<ReviewThreadFilter>('all');
  const sidebarOpen = review?.sidebarOpen ?? navigation?.sidebarOpen ?? true;
  const sidebarControlsId =
    review?.sidebarControlsId ?? navigation?.sidebarControlsId ?? 'folder-browser-sidebar-content';
  const restoredExpandedPaths = useMemo(() => readExpandedTreePaths(paths), [paths]);
  const appliedPathsRef = useRef(paths);
  const handleSelectionChange = useCallback((selectedPaths: readonly string[]) => {
    const nextFile = [...selectedPaths].reverse().find((path) => filePathsRef.current.has(path));
    if (nextFile === undefined) return;
    if (isProgrammaticFolderSelection(nextFile, programmaticSelectionPathRef.current)) {
      programmaticSelectionPathRef.current = undefined;
    } else if (treeMountedRef.current) {
      onSelectFileRef.current?.(nextFile);
    }
    setSelectedPath(nextFile);
  }, []);
  const { model } = useFileTree({
    density: 'default',
    fileTreeSearchMode: 'expand-matches',
    icons: { colored: false, set: 'complete' },
    initialExpansion: restoredExpandedPaths === null ? 'open' : 'closed',
    ...(restoredExpandedPaths === null ? {} : { initialExpandedPaths: restoredExpandedPaths }),
    ...(selectedPath === undefined ? {} : { initialSelectedPaths: [selectedPath] }),
    paths,
    search: true,
    searchBlurBehavior: 'close',
    unsafeCSS: `
      [data-file-tree-search-container][data-open="false"] { display: none; }
      [data-file-tree-search-container][data-open="true"] {
        padding-top: 8px;
        margin-bottom: 4px;
      }
      [data-file-tree-search-input]:focus-visible {
        outline: none;
        box-shadow:
          0 0 0 2px var(--trees-bg),
          0 0 0 4px var(--line-strong);
      }
      :host(:has([data-file-tree-search-input]:focus-visible))
        [data-type="item"][data-item-focused="true"]::before {
        outline-color: transparent;
      }
      [data-file-tree-virtualized-scroll="true"] {
        padding-block: 8px 16px;
      }
    `,
    stickyFolders: true,
    onSelectionChange: handleSelectionChange,
  });

  useEffect(() => {
    treeMountedRef.current = true;
  }, []);

  useEffect(() => {
    if (treeSearchOpen) model.openSearch();
    else model.closeSearch();
  }, [model, treeSearchOpen]);

  useEffect(() => {
    if (appliedPathsRef.current === paths) return;
    const availablePaths = new Set(paths);
    const expandedPaths = expandedTreePaths(appliedPathsRef.current, model).filter((path) =>
      availablePaths.has(path),
    );
    appliedPathsRef.current = paths;
    model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
    try {
      window.sessionStorage.setItem(
        viewerSessionStorageKey('folder-tree'),
        JSON.stringify(expandedPaths),
      );
    } catch {
      // Session storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [model, paths]);

  useEffect(() => {
    if (selectedPath === undefined) return;
    programmaticSelectionPathRef.current = selectedPath;
    model.getItem(selectedPath)?.select();
    try {
      window.sessionStorage.setItem(viewerSessionStorageKey('folder-selected-file'), selectedPath);
    } catch {
      // Folder selection remains usable when browser storage is unavailable.
    }
  }, [model, selectedPath]);

  const toggleSidebar = review?.onSidebarToggle ?? navigation?.onSidebarToggle;
  const previousSidebarOpenRef = useRef(sidebarOpen);

  useEffect(() => {
    const wasOpen = previousSidebarOpenRef.current;
    previousSidebarOpenRef.current = sidebarOpen;
    if (
      wasOpen ||
      !sidebarOpen ||
      toggleSidebar === undefined ||
      typeof window === 'undefined' ||
      window.innerWidth > 640
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const sidebar = document.getElementById(sidebarControlsId);
      const target = sidebar?.querySelector<HTMLElement>('.review-sidebar-close, button, input');
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sidebarControlsId, sidebarOpen, toggleSidebar]);

  useEffect(() => {
    if (!sidebarOpen || toggleSidebar === undefined) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || window.innerWidth > 640) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen, toggleSidebar]);

  useEffect(() => {
    let visibleCount = model.getVisibleCount();
    let pending = false;
    let timeout: number | undefined;
    const persistExpansion = () => {
      pending = false;
      timeout = undefined;
      try {
        window.sessionStorage.setItem(
          viewerSessionStorageKey('folder-tree'),
          JSON.stringify(expandedTreePaths(paths, model)),
        );
      } catch {
        // Session storage can be unavailable in privacy-restricted browser contexts.
      }
    };
    const scheduleExpansionPersistence = () => {
      const nextVisibleCount = model.getVisibleCount();
      const expansionChanged = nextVisibleCount !== visibleCount;
      visibleCount = nextVisibleCount;
      if (model.isSearchOpen()) {
        pending = false;
        if (timeout !== undefined) window.clearTimeout(timeout);
        timeout = undefined;
        return;
      }
      if (!expansionChanged) return;
      pending = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(persistExpansion, 150);
    };
    const unsubscribe = model.subscribe(scheduleExpansionPersistence);
    return () => {
      unsubscribe();
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (pending) persistExpansion();
    };
  }, [model, paths]);

  useEffect(() => {
    if (selectedPath === undefined || filePaths.has(selectedPath)) return;
    setSelectedPath(firstFile?.path);
  }, [filePaths, firstFile?.path, selectedPath]);

  useEffect(() => {
    if (!shouldApplyFolderFocusRequest(focusRequestId, consumedFocusRequestIdRef.current)) return;
    const path = review?.threads.find((thread) => thread.threadId === review.activeThreadId)?.anchor
      .path;
    if (path === undefined || !filePaths.has(path)) return;
    consumedFocusRequestIdRef.current = focusRequestId;
    if (path !== selectedPath) {
      setSelectedPath(path);
      programmaticSelectionPathRef.current = path;
      model.getItem(path)?.select();
    }
  }, [filePaths, focusRequestId, model, review?.activeThreadId, review?.threads, selectedPath]);

  useEffect(() => {
    if (selected === undefined) return;
    const controller = new AbortController();
    setLoadedFile({ path: selected.path, content: { status: 'loading' } });
    const renderer = selectRenderer(selected.mediaType, rendererOrigin, selected.path);
    const sourceView = supportsSourceView(selected.mediaType, selected.path);
    if (renderer.kind === 'download' && !sourceView) {
      setLoadedFile({ path: selected.path, content: { status: 'ready' } });
      return () => controller.abort();
    }
    const remote =
      loadPreviewUrl !== undefined && usesPreviewUrl(renderer)
        ? loadPreviewUrl(selected.path)
        : undefined;
    if (remote !== undefined) {
      setLoadedFile({
        path: selected.path,
        content: { status: 'ready', previewUrl: remote },
      });
      return () => controller.abort();
    }
    if (!requiresClientBytes(renderer) && renderer.kind !== 'image' && !sourceView) {
      setLoadedFile({ path: selected.path, content: { status: 'ready' } });
      return () => controller.abort();
    }
    void loadFile(selected.path, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setLoadedFile({
            path: selected.path,
            content: { status: 'ready', bytes: value },
          });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setLoadedFile({ path: selected.path, content: { status: 'failed' } });
        }
      },
    );
    return () => controller.abort();
  }, [loadFile, loadPreviewUrl, rendererOrigin, selected]);

  const fileContent: ArtifactFileContent =
    loadedFile.path === selected?.path ? loadedFile.content : { status: 'loading' };

  const selectedAnchor: CommentAnchor | undefined =
    selected === undefined || review === undefined || !review.canCreateThread
      ? undefined
      : { revisionId: review.revisionId, path: selected.path, kind: 'file' };

  const folderSidebarOpen = sidebarOpen;

  return (
    <section aria-label="Folder browser" className="folder-browser">
      <ViewerSidebarSplit
        className={
          review ? 'folder-browser-sidebar-split-review' : 'folder-browser-sidebar-split-tree'
        }
        content={
          <div className="folder-browser-preview">
            <div className="folder-browser-content">
              {selected === undefined ? (
                <p className="folder-preview-state">This folder is empty.</p>
              ) : (
                <ArtifactFileView
                  capabilities={{
                    ...(downloadFile === undefined
                      ? {}
                      : { download: () => downloadFile(selected.path) }),
                    ...(authority === undefined ||
                    resolution === undefined ||
                    rendererOrigin === undefined
                      ? {}
                      : {
                          isolatedHtml: {
                            origin: rendererOrigin,
                            render: (renderer, theme) => (
                              <div className="artifact-surface artifact-html">
                                <RendererFrame
                                  authority={authority}
                                  path={selected.path}
                                  renderer={renderer}
                                  resolution={resolution}
                                  theme={theme}
                                />
                              </div>
                            ),
                          },
                        }),
                  }}
                  content={fileContent}
                  file={{
                    id: folderFileViewKey(selected.path, fileContent.status === 'loading'),
                    mediaType: selected.mediaType,
                    name: selected.path,
                  }}
                  {...(review === undefined
                    ? {}
                    : {
                        review: {
                          canCreateThread: review.canCreateThread,
                          revisionId: review.revisionId,
                          path: selected.path,
                          activeThreadId: review.activeThreadId,
                          focusLine: review.focusLine,
                          focusRequestId: review.focusRequestId,
                          threads: review.threads,
                          onCreateThread: review.onCreateThread,
                          onDeletePost: review.onDeletePost,
                          onEditPost: review.onEditPost,
                          onSelectThread: review.onSelectThread,
                          saving: review.saving,
                        },
                      })}
                  {...(toggleSidebar === undefined
                    ? {}
                    : {
                        sidebar: {
                          controlsId: sidebarControlsId,
                          label:
                            review === undefined
                              ? 'folder files sidebar'
                              : 'folder tree and discussions sidebar',
                          onToggle: toggleSidebar,
                          open: sidebarOpen,
                        },
                      })}
                />
              )}
            </div>
          </div>
        }
        sidebarOpen={folderSidebarOpen}
        sidebar={
          <aside className="folder-browser-tree">
            {review !== undefined || navigation !== undefined ? (
              <div
                className="folder-browser-sidebar-content"
                hidden={!sidebarOpen}
                id={sidebarControlsId}
              >
                <ReviewSidebarToolbar
                  discussionCount={review?.threads.length}
                  filesOnly={navigation !== undefined}
                  mode={review?.mode}
                  onModeChange={review?.onModeChange}
                  onSearchToggle={() =>
                    review?.mode === 'discussion'
                      ? setDiscussionSearchOpen((open) => !open)
                      : setTreeSearchOpen((open) => !open)
                  }
                  onClose={toggleSidebar}
                  searchLabel={
                    review?.mode === 'discussion' ? 'Search discussions' : 'Search files'
                  }
                  searchOpen={review?.mode === 'discussion' ? discussionSearchOpen : treeSearchOpen}
                  {...(review?.mode === 'discussion'
                    ? { threadFilter, onThreadFilterChange: setThreadFilter }
                    : {})}
                />
                {review !== undefined ? (
                  <>
                    <div
                      className="folder-browser-sidebar-pane"
                      hidden={review.mode !== 'discussion'}
                    >
                      <DiscussionPanel
                        activeThreadId={review.activeThreadId}
                        error={review.error}
                        loading={review.loading}
                        newAnchor={selectedAnchor}
                        onCreateThread={review.onCreateThread}
                        onDeletePost={review.onDeletePost}
                        onEditPost={review.onEditPost}
                        onReply={review.onReply}
                        onModeratePost={review.onModeratePost}
                        onNavigateToThread={review.onNavigateToThread}
                        onSelectThread={review.onSelectThread}
                        onSetThreadStatus={review.onSetThreadStatus}
                        moderator={review.moderator}
                        saving={review.saving}
                        selectedPath={selectedPath}
                        onSearchToggle={() => setDiscussionSearchOpen((open) => !open)}
                        searchOpen={discussionSearchOpen}
                        showToolbar={false}
                        threadFilter={threadFilter}
                        onThreadFilterChange={setThreadFilter}
                        threads={review.threads}
                      />
                    </div>
                    <div
                      className="folder-browser-sidebar-pane"
                      hidden={review.mode === 'discussion'}
                    >
                      <FileTree
                        aria-label="Folder contents"
                        className="folder-browser-pierre-tree"
                        model={model}
                      />
                    </div>
                  </>
                ) : (
                  <FileTree
                    aria-label="Folder contents"
                    className="folder-browser-pierre-tree"
                    model={model}
                  />
                )}
              </div>
            ) : (
              <FileTree
                aria-label="Folder contents"
                className="folder-browser-pierre-tree"
                model={model}
              />
            )}
          </aside>
        }
      />
    </section>
  );
}
