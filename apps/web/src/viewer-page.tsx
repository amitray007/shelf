import type { CommentAnchor } from '@shelf/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData, useRevalidator } from 'react-router';

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
import { ArtifactContent } from './components/artifact-content.js';
import { decodeFileSource } from './components/file-view.js';
import { FolderBrowser, type FolderBrowserReview } from './components/folder-browser.js';
import { DiscussionPanel } from './components/review/discussion-panel.js';
import { readReviewValue, writeReviewValue } from './components/review/persistence.js';
import type { ReviewSidebarMode } from './components/review/types.js';
import { reviewPanelStorageKey, useViewerReview } from './components/review/use-review.js';
import { ViewerRail } from './components/viewer-shell.js';
import { ViewerSidebarSplit } from './components/viewer-sidebar-split.js';
import {
  normalizeMediaType,
  type PassiveRenderer,
  selectRenderer,
  supportsSourceView,
} from './rendering.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

interface PreparedFile {
  readonly renderer: PassiveRenderer;
  readonly text?: string;
}

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

function prepareFile(
  resolution: FileShareResolution,
  bytes: ArrayBuffer | null,
  rendererOrigin: string | undefined,
): PreparedFile {
  const selected = selectRenderer(resolution.revision.mediaType, rendererOrigin);
  if (bytes === null || !supportsSourceView(resolution.revision.mediaType)) {
    return { renderer: selected };
  }
  const text = decodeFileSource(bytes);
  return text === null ? { renderer: { kind: 'download' } } : { renderer: selected, text };
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
  return loadViewerPayload(reference, authority, request.signal, config.rendererOrigin);
}

export async function loadViewerPayload(
  reference: ViewerShareReference,
  authority: ViewerAuthority,
  signal: AbortSignal | undefined,
  rendererOrigin: string | undefined,
): Promise<PublicSharePayload> {
  const resolution = await resolveViewerShare(reference, authority, signal);
  if (isFolderShareResolution(resolution)) {
    return {
      kind: 'folder',
      resolution,
      authority,
      entries: await loadViewerFolderEntries(resolution, authority, signal),
    };
  }
  if (!isFileShareResolution(resolution)) throw new PublicShareUnavailableError();
  const renderer = selectRenderer(resolution.revision.mediaType, rendererOrigin);
  const needsBytes =
    ['text', 'json', 'markdown', 'image'].includes(renderer.kind) ||
    supportsSourceView(resolution.revision.mediaType);
  return {
    kind: 'file',
    resolution,
    authority,
    bytes: needsBytes ? await loadViewerFileBytes(resolution, authority, signal) : null,
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
  readonly review?: React.ComponentProps<typeof ArtifactContent>['review'];
  readonly sidebarOpen?: boolean | undefined;
  readonly onOpenSidebar?: (() => void) | undefined;
}) {
  const downloadUrl = useMemo(
    () =>
      payload.bytes === null ||
      (selectRenderer(payload.resolution.revision.mediaType, payload.rendererOrigin).kind !==
        'image' &&
        normalizeMediaType(payload.resolution.revision.mediaType) !== 'image/svg+xml')
        ? undefined
        : URL.createObjectURL(
            new Blob([payload.bytes], { type: payload.resolution.revision.mediaType }),
          ),
    [payload.bytes, payload.rendererOrigin, payload.resolution.revision.mediaType],
  );
  useEffect(
    () => () => {
      if (downloadUrl !== undefined) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  const prepared = useMemo(
    () => prepareFile(payload.resolution, payload.bytes, payload.rendererOrigin),
    [payload.bytes, payload.rendererOrigin, payload.resolution],
  );
  return (
    <ArtifactContent
      {...(downloadUrl === undefined ? {} : { downloadUrl })}
      {...(prepared.text === undefined ? {} : { text: prepared.text })}
      renderer={prepared.renderer}
      resolution={payload.resolution}
      authority={payload.authority}
      onOpenSidebar={onOpenSidebar}
      review={review}
      sidebarControlsId="viewer-discussion-sidebar"
      sidebarLabel="file discussions sidebar"
      sidebarOpen={sidebarOpen}
    />
  );
}

function FolderArtifact({
  payload,
  review,
}: {
  readonly payload: Extract<PublicSharePayload, { kind: 'folder' }>;
  readonly review?: FolderBrowserReview | undefined;
}) {
  const loadFile = useCallback(
    (path: string, signal: AbortSignal) =>
      loadViewerFolderEntryBytes(payload.resolution, payload.authority, path, signal),
    [payload.authority, payload.resolution],
  );
  return (
    <FolderBrowser
      entries={payload.entries}
      key={payload.resolution.revision.revisionId}
      loadFile={loadFile}
      review={review}
    />
  );
}

export function ViewerPage() {
  const payload = useLoaderData() as PublicSharePayload;
  const { revalidate } = useRevalidator();
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
      <ViewerRail authority={payload.authority} resolution={payload.resolution} />
      <div className="viewer-main">
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
          />
        )}
      </div>
    </div>
  );
}
