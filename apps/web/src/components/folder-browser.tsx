// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import type { FileTreeDirectoryHandle } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { CommentAnchor, CommentThread, FolderEntry } from '@shelf/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizeMediaType, selectRenderer, supportsSourceView } from '../rendering.js';
import {
  CodeView,
  decodeFileSource,
  FileLoadingState,
  FileView,
  formatJson,
  viewerSessionStorageKey,
} from './file-view.js';
import { formatBytes } from './format.js';
import { MarkdownView } from './markdown-view.js';
import { DiscussionPanel } from './review/discussion-panel.js';
import { ReviewSidebarRail, ReviewSidebarToolbar } from './review/sidebar-toolbar.js';
import type { ReviewSidebarMode, ReviewThreadFilter } from './review/types.js';

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
  readonly entries: readonly FolderEntry[];
  readonly loadFile: (path: string, signal: AbortSignal) => Promise<ArrayBuffer>;
  readonly review?: FolderBrowserReview | undefined;
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

function FolderImage({
  bytes,
  mediaType,
  path,
}: {
  bytes: ArrayBuffer;
  mediaType: string;
  path: string;
}) {
  const source = useMemo(
    () => URL.createObjectURL(new Blob([bytes], { type: mediaType })),
    [bytes, mediaType],
  );
  useEffect(() => () => URL.revokeObjectURL(source), [source]);
  return (
    <section className="artifact-surface artifact-image">
      <img alt={path} className="folder-preview-image" referrerPolicy="no-referrer" src={source} />
    </section>
  );
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

export function FolderBrowser({ entries, loadFile, review }: FolderBrowserProps) {
  const firstFile = entries.find((entry) => entry.kind === 'file');
  const paths = useMemo(
    () => entries.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path)),
    [entries],
  );
  const filePaths = useMemo(
    () => new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)),
    [entries],
  );
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
  const [bytes, setBytes] = useState<ArrayBuffer>();
  const [failed, setFailed] = useState(false);
  const [treeSearchOpen, setTreeSearchOpen] = useState(false);
  const [discussionSearchOpen, setDiscussionSearchOpen] = useState(false);
  const [threadFilter, setThreadFilter] = useState<ReviewThreadFilter>('all');
  const sidebarOpen = review?.sidebarOpen ?? true;
  const sidebarControlsId = review?.sidebarControlsId ?? 'folder-browser-sidebar-content';
  const railButtonRef = useRef<HTMLButtonElement>(null);
  const previousSidebarOpenRef = useRef(sidebarOpen);
  const previousReviewPresentRef = useRef(review !== undefined);
  const restoredExpandedPaths = useMemo(() => readExpandedTreePaths(paths), [paths]);
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
    const expandedPaths = expandedTreePaths(paths, model);
    if (selectedPath !== undefined) programmaticSelectionPathRef.current = selectedPath;
    model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
    try {
      window.sessionStorage.setItem(
        viewerSessionStorageKey('folder-tree'),
        JSON.stringify(expandedPaths),
      );
    } catch {
      // Session storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [model, paths, selectedPath]);

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

  useEffect(() => {
    if (previousReviewPresentRef.current && previousSidebarOpenRef.current && !sidebarOpen) {
      railButtonRef.current?.focus();
    }
    previousSidebarOpenRef.current = sidebarOpen;
    previousReviewPresentRef.current = review !== undefined;
  }, [review, sidebarOpen]);

  useEffect(() => {
    const persistExpansion = () => {
      try {
        window.sessionStorage.setItem(
          viewerSessionStorageKey('folder-tree'),
          JSON.stringify(expandedTreePaths(paths, model)),
        );
      } catch {
        // Session storage can be unavailable in privacy-restricted browser contexts.
      }
    };
    persistExpansion();
    return model.subscribe(persistExpansion);
  }, [model, paths]);

  const selected = entries.find(
    (entry): entry is Extract<FolderEntry, { kind: 'file' }> =>
      entry.kind === 'file' && entry.path === selectedPath,
  );

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
    setBytes(undefined);
    setFailed(false);
    void loadFile(selected.path, controller.signal).then(
      (value) => setBytes(value),
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [loadFile, selected]);

  const source =
    selected !== undefined && bytes !== undefined && supportsSourceView(selected.mediaType)
      ? decodeFileSource(bytes)
      : null;

  const preview = useMemo(() => {
    if (selected === undefined)
      return <p className="folder-preview-state">This folder is empty.</p>;
    if (failed) return <p className="folder-preview-state">This file could not be loaded.</p>;
    if (bytes === undefined) return <FileLoadingState />;
    const normalizedMediaType = normalizeMediaType(selected.mediaType);
    const renderer = selectRenderer(selected.mediaType, undefined);
    let renderedPreview: React.ReactNode | undefined;
    if (renderer.kind === 'image' || normalizedMediaType === 'image/svg+xml') {
      renderedPreview = (
        <FolderImage bytes={bytes} mediaType={selected.mediaType} path={selected.path} />
      );
    } else if (renderer.kind === 'markdown' && source !== null) {
      renderedPreview = (
        <section
          aria-label="Artifact document preview"
          className="artifact-surface artifact-document"
          tabIndex={0}
        >
          <MarkdownView source={source} />
        </section>
      );
    } else if (renderer.kind === 'json' && source !== null) {
      renderedPreview = (
        <CodeView
          fileName={selected.path}
          label="Artifact data preview"
          source={formatJson(source)}
        />
      );
    }
    if (renderedPreview === undefined && source === null) {
      return <p className="folder-preview-state">Preview unavailable for this file type.</p>;
    }
    return renderedPreview;
  }, [bytes, failed, selected, source]);

  const fileHeader =
    selected === undefined ? undefined : (
      <>
        <strong title={selected.path}>{selected.path}</strong>
        <span>{formatBytes(selected.byteCount)}</span>
      </>
    );

  const selectedAnchor: CommentAnchor | undefined =
    selected === undefined || review === undefined || !review.canCreateThread
      ? undefined
      : { revisionId: review.revisionId, path: selected.path, kind: 'file' };

  const folderBrowserClassName = `folder-browser${review && !sidebarOpen ? ' folder-browser-sidebar-collapsed' : ''}`;

  return (
    <section aria-label="Folder browser" className={folderBrowserClassName}>
      <aside className="folder-browser-tree">
        {review ? (
          <>
            <div
              className="folder-browser-sidebar-content"
              hidden={!sidebarOpen}
              id={sidebarControlsId}
            >
              <ReviewSidebarToolbar
                discussionCount={review.threads.length}
                mode={review.mode}
                onModeChange={review.onModeChange}
                {...(review.onSidebarToggle === undefined
                  ? {}
                  : {
                      onCollapse: review.onSidebarToggle,
                      sidebarControlsId,
                      sidebarLabel: 'folder tree and discussions sidebar',
                    })}
                onSearchToggle={() =>
                  review.mode === 'discussion'
                    ? setDiscussionSearchOpen((open) => !open)
                    : setTreeSearchOpen((open) => !open)
                }
                searchLabel={review.mode === 'discussion' ? 'Search discussions' : 'Search files'}
                searchOpen={review.mode === 'discussion' ? discussionSearchOpen : treeSearchOpen}
                {...(review.mode === 'discussion'
                  ? { threadFilter, onThreadFilterChange: setThreadFilter }
                  : {})}
              />
              {review.mode === 'discussion' ? (
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
              ) : (
                <FileTree
                  aria-label="Folder contents"
                  className="folder-browser-pierre-tree"
                  model={model}
                />
              )}
            </div>
            {!sidebarOpen ? (
              <ReviewSidebarRail
                buttonRef={railButtonRef}
                onOpen={review.onSidebarToggle ?? (() => undefined)}
                sidebarLabel="folder tree and discussions sidebar"
                sidebarControlsId={sidebarControlsId}
              />
            ) : null}
          </>
        ) : (
          <FileTree
            aria-label="Folder contents"
            className="folder-browser-pierre-tree"
            model={model}
          />
        )}
      </aside>
      <div className="folder-browser-preview">
        <div className="folder-browser-content">
          <FileView
            {...(fileHeader === undefined ? {} : { header: fileHeader })}
            {...(source === null ? {} : { source })}
            {...(selected === undefined ? {} : { fileName: selected.path })}
            {...(review === undefined
              ? {}
              : {
                  review: {
                    canCreateThread: review.canCreateThread,
                    revisionId: review.revisionId,
                    ...(selected === undefined ? {} : { path: selected.path }),
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
            key={folderFileViewKey(selected?.path, bytes === undefined)}
            preview={preview}
          />
        </div>
      </div>
    </section>
  );
}
