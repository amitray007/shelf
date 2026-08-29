import type { CommentAnchor } from '@shelf/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useLocation, useNavigate, useRevalidator } from 'react-router';

import {
  establishProtectedSession,
  loadPublicClientConfig,
  loadViewerFileBytes,
  loadViewerFolderEntries,
  loadViewerFolderEntryBytes,
  type PublicSharePayload,
  PublicShareUnavailableError,
  resolveViewerShare,
  type ViewerAuthority,
  viewerShareActionUrl,
  viewerShareDownloadUrl,
  viewerSharePreviewUrl,
} from './api.js';
import {
  capabilityStorageKey,
  captureShareCapability,
  readOrCreateProtectedSessionId,
  readProtectedViewerToken,
  saveProtectedSessionAuthority,
  shareReferenceFromViewerPath,
  type ViewerShareReference,
} from './capability.js';
import { ArtifactFileView } from './components/artifact-file-view.js';
import type { FolderBrowserReview } from './components/folder-browser.js';
import { LazyFolderBrowser as FolderBrowser } from './components/lazy-views.js';
import { RendererFrame } from './components/renderer-frame.js';
import { DiscussionPanel } from './components/review/discussion-panel.js';
import { readReviewValue, writeReviewValue } from './components/review/persistence.js';
import type { ReviewSidebarMode } from './components/review/types.js';
import { reviewPanelStorageKey, useViewerReview } from './components/review/use-review.js';
import { ViewerRail } from './components/viewer-shell.js';
import { ViewerSidebarSplit } from './components/viewer-sidebar-split.js';
import {
  prefetchRendererModules,
  requiresClientBytes,
  selectRenderer,
  usesPreviewUrl,
} from './rendering.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
  type ShareRevisionPointer,
  shareLatestRevision,
  shareRevisionAccess,
} from './share-types.js';

export function updateViewerThreadUrl(currentUrl: string, threadId: string): string {
  const url = new URL(currentUrl, 'https://shelf.invalid');
  if (threadId === '') url.searchParams.delete('thread');
  else url.searchParams.set('thread', threadId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function readViewerSidebarOpen(
  resolution: FileShareResolution | FolderShareResolution,
): boolean {
  const persisted = readReviewValue(reviewPanelStorageKey(resolution));
  if (persisted === 'open') return true;
  if (persisted === 'closed') return false;
  return isFolderShareResolution(resolution);
}

export async function viewerLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<PublicSharePayload> {
  const reference = shareReferenceFromViewerPath(`/s/${params.shareRef ?? ''}`);
  if (reference === null) throw new PublicShareUnavailableError();

  let authority: ViewerAuthority;
  if (reference.accessType === 'public') {
    authority = { accessType: 'public', publicCode: reference.publicCode };
  } else {
    const sessionId = readOrCreateProtectedSessionId(reference.shareId, window.sessionStorage);
    if (sessionId === null) throw new PublicShareUnavailableError();
    const token = readProtectedViewerToken(reference.shareId, window.sessionStorage);
    const secret =
      token === null
        ? captureShareCapability({
            shareId: reference.shareId,
            location: window.location,
            history: window.history,
            sessionStorage: window.sessionStorage,
          })
        : null;
    if (token === null && secret === null) throw new PublicShareUnavailableError();
    try {
      const established = await establishProtectedSession(
        reference.shareId,
        sessionId,
        token === null ? { secret: secret as string } : { token },
        request.signal,
      );
      saveProtectedSessionAuthority(window.sessionStorage, established);
      authority = {
        accessType: 'protected',
        shareId: established.shareId,
        sessionId: established.sessionId,
        token: established.token,
      };
    } catch (error) {
      if (
        token === null &&
        error instanceof PublicShareUnavailableError &&
        error.failure === 'terminal'
      ) {
        try {
          window.sessionStorage.removeItem(capabilityStorageKey(reference.shareId));
        } catch {
          // Terminal failures use the same unavailable projection even without writable storage.
        }
      }
      throw error;
    }
  }

  const config = await loadPublicClientConfig(request.signal);
  const revisionId = new URL(request.url).searchParams.get('revision') ?? undefined;
  return loadViewerPayload(reference, authority, request.signal, config.rendererOrigin, revisionId);
}

export async function loadViewerPayload(
  reference: ViewerShareReference,
  authority: ViewerAuthority,
  signal: AbortSignal | undefined,
  rendererOrigin: string | undefined,
  revisionId?: string,
): Promise<PublicSharePayload> {
  const resolution = await resolveViewerShare(reference, authority, signal, revisionId);
  if (isFolderShareResolution(resolution)) {
    prefetchRendererModules({ kind: 'folder' });
    return {
      kind: 'folder',
      resolution,
      authority,
      entries: await loadViewerFolderEntries(resolution, authority, signal),
      ...(rendererOrigin === undefined ? {} : { rendererOrigin }),
    };
  }
  if (!isFileShareResolution(resolution)) throw new PublicShareUnavailableError();
  prefetchRendererModules({
    kind: 'file',
    mediaType: resolution.revision.mediaType,
    originalFileName: resolution.revision.originalFileName,
  });
  const renderer = selectRenderer(
    resolution.revision.mediaType,
    rendererOrigin,
    resolution.revision.originalFileName,
  );
  const needsBytes = requiresClientBytes(renderer);
  const previewUrl = usesPreviewUrl(renderer)
    ? viewerSharePreviewUrl(resolution, authority)
    : undefined;
  return {
    kind: 'file',
    resolution,
    authority,
    bytes: needsBytes ? await loadViewerFileBytes(resolution, authority, signal) : null,
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(rendererOrigin === undefined ? {} : { rendererOrigin }),
  };
}

function FileArtifact({
  payload,
  review,
  sidebarOpen,
  onOpenSidebar,
}: {
  readonly payload: Extract<PublicSharePayload, { kind: 'file' }>;
  readonly review?: React.ComponentProps<typeof ArtifactFileView>['review'];
  readonly sidebarOpen?: boolean | undefined;
  readonly onOpenSidebar?: (() => void) | undefined;
}) {
  const download = useCallback(() => {
    try {
      submitViewerDownload(
        viewerShareActionUrl(payload.resolution, payload.authority),
        payload.authority,
        payload.resolution,
      );
    } catch {
      return;
    }
  }, [payload.authority, payload.resolution]);
  return (
    <ArtifactFileView
      capabilities={{
        download,
        ...(payload.rendererOrigin === undefined
          ? {}
          : {
              isolatedHtml: {
                origin: payload.rendererOrigin,
                render: (renderer, theme) => (
                  <div className="artifact-surface artifact-html">
                    <RendererFrame
                      authority={payload.authority}
                      renderer={renderer}
                      resolution={payload.resolution}
                      theme={theme}
                    />
                  </div>
                ),
              },
            }),
      }}
      content={{
        status: 'ready',
        ...(payload.bytes === null ? {} : { bytes: payload.bytes }),
        ...(payload.previewUrl === undefined ? {} : { previewUrl: payload.previewUrl }),
      }}
      file={{
        id: payload.resolution.revision.revisionId,
        mediaType: payload.resolution.revision.mediaType,
        name: payload.resolution.revision.originalFileName,
      }}
      review={review}
      {...(onOpenSidebar === undefined || sidebarOpen === undefined
        ? {}
        : {
            sidebar: {
              controlsId: 'viewer-discussion-sidebar',
              label: 'file discussions sidebar',
              onToggle: onOpenSidebar,
              open: sidebarOpen,
            },
          })}
    />
  );
}

function submitViewerDownload(
  action: string,
  authority: ViewerAuthority,
  resolution: FileShareResolution | FolderShareResolution,
) {
  const form = document.createElement('form');
  form.action = action;
  form.method = authority.accessType === 'protected' ? 'post' : 'get';
  form.hidden = true;
  if (authority.accessType === 'protected') {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'token';
    input.value = authority.token;
    form.append(input);
    if (
      resolution.target.mode === 'pinned' ||
      shareRevisionAccess(resolution) === 'shared-history'
    ) {
      const revisionInput = document.createElement('input');
      revisionInput.type = 'hidden';
      revisionInput.name = 'revisionId';
      revisionInput.value = resolution.revision.revisionId;
      form.append(revisionInput);
    }
  }
  document.body.append(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
}

function FolderArtifact({
  payload,
  review,
  sidebarOpen,
  onSidebarToggle,
}: {
  readonly payload: Extract<PublicSharePayload, { kind: 'folder' }>;
  readonly review?: FolderBrowserReview | undefined;
  readonly sidebarOpen: boolean;
  readonly onSidebarToggle: () => void;
}) {
  const loadFile = useCallback(
    (path: string, signal: AbortSignal) =>
      loadViewerFolderEntryBytes(payload.resolution, payload.authority, path, signal),
    [payload.authority, payload.resolution],
  );
  const loadPreviewUrl = useCallback(
    (path: string) => viewerSharePreviewUrl(payload.resolution, payload.authority, path),
    [payload.authority, payload.resolution],
  );
  const downloadFile = useCallback(
    (path: string) => {
      try {
        submitViewerDownload(
          viewerShareDownloadUrl(payload.resolution, payload.authority, path),
          payload.authority,
          payload.resolution,
        );
      } catch {
        return;
      }
    },
    [payload.authority, payload.resolution],
  );
  return (
    <FolderBrowser
      authority={payload.authority}
      entries={payload.entries}
      key={payload.resolution.revision.revisionId}
      loadFile={loadFile}
      loadPreviewUrl={loadPreviewUrl}
      downloadFile={downloadFile}
      rendererOrigin={payload.rendererOrigin}
      resolution={payload.resolution}
      {...(review === undefined
        ? {
            navigation: {
              onSidebarToggle,
              sidebarControlsId: 'viewer-folder-sidebar',
              sidebarOpen,
            },
          }
        : { review })}
    />
  );
}

export function ViewerPage() {
  const payload = useLoaderData() as PublicSharePayload;
  const location = useLocation();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [latestAvailable, setLatestAvailable] = useState<ShareRevisionPointer | undefined>(() => {
    const latestRevision = shareLatestRevision(payload.resolution);
    return payload.resolution.revision.revisionId === latestRevision.revisionId
      ? undefined
      : latestRevision;
  });
  useEffect(() => {
    const latestRevision = shareLatestRevision(payload.resolution);
    setLatestAvailable(
      payload.resolution.revision.revisionId === latestRevision.revisionId
        ? undefined
        : latestRevision,
    );
  }, [payload.resolution]);
  const checkForUpdates = useCallback(async () => {
    if (checkingUpdates) return;
    setCheckingUpdates(true);
    const reference: ViewerShareReference =
      payload.authority.accessType === 'protected'
        ? { accessType: 'protected', shareId: payload.authority.shareId }
        : { accessType: 'public', publicCode: payload.authority.publicCode };
    try {
      const current = await resolveViewerShare(reference, payload.authority);
      const latestRevision = shareLatestRevision(current);
      setLatestAvailable(
        latestRevision.revisionId === payload.resolution.revision.revisionId
          ? undefined
          : latestRevision,
      );
    } catch {
      // A failed background check must not replace content that is already open.
    } finally {
      setCheckingUpdates(false);
    }
  }, [checkingUpdates, payload.authority, payload.resolution.revision.revisionId]);
  useEffect(() => {
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') void checkForUpdates();
    };
    window.addEventListener('focus', checkWhenVisible);
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      window.removeEventListener('focus', checkWhenVisible);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, [checkForUpdates]);
  const selectRevision = useCallback(
    (revisionId: string | null) => {
      const next = new URLSearchParams(location.search);
      if (revisionId === null) next.delete('revision');
      else next.set('revision', revisionId);
      next.delete('thread');
      void navigate(
        { pathname: location.pathname, search: next.size === 0 ? '' : `?${next}` },
        { replace: false },
      );
    },
    [location.pathname, location.search, navigate],
  );
  const handleRevisionMismatch = useCallback(
    (anchor: CommentAnchor) => {
      // A file anchor has no text/range to remap, so refreshing Latest is safe.
      // Keep line/range viewers on the rendered revision so their draft and
      // anchor cannot be silently attached to a different revision.
      if (anchor.kind === 'file') revalidate();
    },
    [revalidate],
  );
  const review = useViewerReview(
    payload.resolution,
    payload.authority,
    payload.resolution.commentPolicy,
    handleRevisionMismatch,
  );
  const [discussionOpen, setDiscussionOpen] = useState(() => {
    return readViewerSidebarOpen(payload.resolution);
  });
  const [folderMode, setFolderMode] = useState<ReviewSidebarMode>(() => {
    return readReviewValue(`${reviewPanelStorageKey(payload.resolution)}:mode`) === 'discussion'
      ? 'discussion'
      : 'tree';
  });
  const [focusedLine, setFocusedLine] = useState<number>();
  const [focusRequestId, setFocusRequestId] = useState(0);

  useEffect(() => {
    const threadId = new URLSearchParams(window.location.search).get('thread');
    if (threadId !== null && review.enabled) {
      review.selectThread(threadId);
      setDiscussionOpen(true);
      if (payload.kind === 'folder') setFolderMode('discussion');
    }
  }, [payload.kind, review.enabled, review.selectThread]);

  const setDiscussionVisibility = (open: boolean) => {
    setDiscussionOpen(open);
    writeReviewValue(reviewPanelStorageKey(payload.resolution), open ? 'open' : 'closed');
  };
  const setMode = (mode: ReviewSidebarMode) => {
    setFolderMode(mode);
    writeReviewValue(`${reviewPanelStorageKey(payload.resolution)}:mode`, mode);
  };
  const selectReviewThread = (threadId: string) => {
    setFocusedLine(undefined);
    review.selectThread(threadId);
    if (typeof window !== 'undefined') {
      window.history.replaceState(
        window.history.state,
        '',
        updateViewerThreadUrl(
          `${window.location.pathname}${window.location.search}${window.location.hash}`,
          threadId,
        ),
      );
    }
    if (payload.kind === 'file') setDiscussionVisibility(true);
    else if (threadId !== '') setMode('discussion');
  };
  const clearReviewNavigation = () => selectReviewThread('');
  const navigateToReviewThread = (threadId: string) => {
    const thread = review.threads.find((candidate) => candidate.threadId === threadId);
    const line = thread?.anchor.startLine;
    if (line === undefined) return;
    selectReviewThread(threadId);
    setFocusedLine(line);
    setFocusRequestId((current) => current + 1);
    if (payload.kind === 'folder') setMode('tree');
  };

  useEffect(() => {
    document.title = `${payload.resolution.artifact.name} · shelf`;
    return () => {
      document.title = 'shelf';
    };
  }, [payload.resolution.artifact.name]);

  return (
    <div className="viewer">
      <ViewerRail
        authority={payload.authority}
        checkingUpdates={checkingUpdates}
        onCheckUpdates={() => void checkForUpdates()}
        onRevisionSelect={selectRevision}
        resolution={payload.resolution}
        {...(latestAvailable === undefined ? {} : { latestAvailable })}
      />
      <main className="viewer-main">
        {payload.kind === 'file' ? (
          review.enabled ? (
            <ViewerSidebarSplit
              content={
                <FileArtifact
                  payload={payload}
                  onOpenSidebar={() => setDiscussionVisibility(!discussionOpen)}
                  review={{
                    canCreateThread: review.writable,
                    revisionId: payload.resolution.revision.revisionId,
                    threads: review.threads,
                    activeThreadId: review.activeThreadId,
                    onCreateThread: review.createThread,
                    onDeletePost: review.deletePost,
                    onEditPost: review.editPost,
                    focusLine: focusedLine,
                    focusRequestId,
                    onSelectThread: selectReviewThread,
                    saving: review.saving,
                  }}
                  sidebarOpen={discussionOpen}
                />
              }
              sidebarOpen={discussionOpen}
              sidebar={
                <DiscussionPanel
                  activeThreadId={review.activeThreadId}
                  collapsed={!discussionOpen}
                  collapsible
                  error={review.error}
                  loading={review.loading}
                  loadingOlder={review.loadingOlder}
                  nextCursor={review.nextCursor}
                  newAnchor={
                    review.writable
                      ? { revisionId: payload.resolution.revision.revisionId, kind: 'file' }
                      : undefined
                  }
                  onLoadOlder={review.loadOlder}
                  onCreateThread={review.createThread}
                  onDeletePost={review.deletePost}
                  onEditPost={review.editPost}
                  onReply={review.reply}
                  onSelectThread={selectReviewThread}
                  onNavigateToThread={navigateToReviewThread}
                  onSetThreadStatus={review.setThreadStatus}
                  publicViewer
                  saving={review.saving}
                  sidebarControlsId="viewer-discussion-sidebar"
                  threads={review.threads}
                />
              }
            />
          ) : (
            <FileArtifact payload={payload} />
          )
        ) : (
          <FolderArtifact
            payload={payload}
            review={
              review.enabled
                ? {
                    canCreateThread: review.writable,
                    revisionId: payload.resolution.revision.revisionId,
                    threads: review.threads,
                    activeThreadId: review.activeThreadId,
                    focusLine: focusedLine,
                    focusRequestId,
                    loading: review.loading,
                    saving: review.saving,
                    error: review.error,
                    mode: folderMode,
                    sidebarOpen: discussionOpen,
                    onSidebarToggle: () => setDiscussionVisibility(!discussionOpen),
                    sidebarControlsId: 'viewer-folder-sidebar',
                    onModeChange: setMode,
                    onSelectFile: clearReviewNavigation,
                    onSelectThread: selectReviewThread,
                    onNavigateToThread: navigateToReviewThread,
                    onCreateThread: review.createThread,
                    onReply: review.reply,
                    onSetThreadStatus: review.setThreadStatus,
                    onEditPost: review.editPost,
                    onDeletePost: review.deletePost,
                  }
                : undefined
            }
            onSidebarToggle={() => setDiscussionVisibility(!discussionOpen)}
            sidebarOpen={discussionOpen}
          />
        )}
      </main>
    </div>
  );
}
