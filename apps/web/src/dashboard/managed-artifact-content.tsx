import type { ArtifactRevision, CommentAnchor, CommentThread, FolderEntry } from '@shelf/contracts';
import { memo, useCallback, useState } from 'react';

import { ArtifactFileView } from '../components/artifact-file-view.js';
import { LazyFolderBrowser as FolderBrowser } from '../components/lazy-views.js';
import { DiscussionPanel } from '../components/review/discussion-panel.js';
import type { ReviewSidebarMode } from '../components/review/types.js';
import { selectRenderer, usesPreviewUrl } from '../rendering.js';
import {
  folderEntryDownloadUrl,
  folderEntryPreviewUrl,
  loadFolderEntryBytes,
  revisionPreviewUrl,
} from './api.js';

export interface ManagedArtifactReview {
  readonly moderator?: boolean | undefined;
  readonly canCreateThread: boolean;
  readonly revisionId: string;
  readonly threads: readonly CommentThread[];
  readonly activeThreadId?: string | undefined;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly onNavigateToThread?: ((threadId: string) => void) | undefined;
  readonly loading?: boolean | undefined;
  readonly loadingOlder?: boolean | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly mode?: ReviewSidebarMode | undefined;
  readonly onModeChange?: ((mode: ReviewSidebarMode) => void) | undefined;
  readonly sidebarOpen?: boolean | undefined;
  readonly onSidebarToggle?: (() => void) | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly onSelectThread: (threadId: string) => void;
  readonly onLoadOlder?: (() => Promise<void>) | undefined;
  readonly onCreateThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onSetThreadStatus: (threadId: string, status: 'resolve' | 'reopen') => Promise<void>;
  readonly onModeratePost?:
    | ((postId: string, moderation: 'hide' | 'unhide') => Promise<void>)
    | undefined;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
}

export const ManagedArtifactContent = memo(function ManagedArtifactContent({
  revision,
  bytes,
  entries,
  review,
  discussionOpen = false,
  onDiscussionToggle,
}: {
  readonly revision: ArtifactRevision;
  readonly bytes: ArrayBuffer | null;
  readonly entries: readonly FolderEntry[];
  readonly review?: ManagedArtifactReview | undefined;
  readonly discussionOpen?: boolean | undefined;
  readonly onDiscussionToggle?: (() => void) | undefined;
}) {
  const loadFolderFile = useCallback(
    (path: string, signal: AbortSignal) => loadFolderEntryBytes(revision.revisionId, path, signal),
    [revision.revisionId],
  );
  const [previewFolderSidebarOpen, setPreviewFolderSidebarOpen] = useState(true);
  const togglePreviewFolderSidebar = useCallback(
    () => setPreviewFolderSidebarOpen((open) => !open),
    [],
  );

  if (revision.kind === 'folder') {
    return (
      <FolderBrowser
        entries={entries}
        key={revision.revisionId}
        loadFile={loadFolderFile}
        loadPreviewUrl={(path) => folderEntryPreviewUrl(revision.revisionId, path)}
        downloadFile={(path) =>
          window.location.assign(folderEntryDownloadUrl(revision.revisionId, path))
        }
        {...(review === undefined
          ? {
              navigation: {
                onSidebarToggle: togglePreviewFolderSidebar,
                sidebarControlsId: 'preview-folder-sidebar-content',
                sidebarOpen: previewFolderSidebarOpen,
              },
            }
          : {
              review: {
                ...review,
                mode: review.mode ?? 'tree',
                onModeChange: review.onModeChange ?? (() => undefined),
              },
            })}
      />
    );
  }

  const renderer = selectRenderer(revision.mediaType, undefined, revision.originalFileName);
  const previewUrl = usesPreviewUrl(renderer) ? revisionPreviewUrl(revision.revisionId) : undefined;

  return (
    <div className="managed-file-review-stage">
      <div className="managed-file-review-body">
        <div className="managed-file-preview">
          <ArtifactFileView
            capabilities={{
              download: () => window.location.assign(revision.paths.content),
            }}
            content={{
              status: 'ready',
              ...(bytes === null ? {} : { bytes }),
              ...(previewUrl === undefined ? {} : { previewUrl }),
            }}
            file={{
              id: revision.revisionId,
              mediaType: revision.mediaType,
              name: revision.originalFileName,
            }}
            {...(review === undefined
              ? {}
              : {
                  review: {
                    canCreateThread: false,
                    revisionId: review.revisionId,
                    threads: review.threads,
                    activeThreadId: review.activeThreadId,
                    focusLine: review.focusLine,
                    focusRequestId: review.focusRequestId,
                    onCreateThread: review.onCreateThread,
                    onDeletePost: review.onDeletePost,
                    onEditPost: review.onEditPost,
                    onSelectThread: review.onSelectThread,
                    saving: review.saving,
                  },
                })}
            {...(review === undefined || onDiscussionToggle === undefined
              ? {}
              : {
                  sidebar: {
                    controlsId: 'managed-artifact-discussion-sidebar',
                    label: 'discussions sidebar',
                    onToggle: onDiscussionToggle,
                    open: discussionOpen,
                  },
                })}
          />
        </div>
        {review && discussionOpen ? (
          <DiscussionPanel
            activeThreadId={review.activeThreadId}
            error={review.error}
            loading={review.loading}
            loadingOlder={review.loadingOlder}
            nextCursor={review.nextCursor}
            moderator={review.moderator}
            onCreateThread={review.onCreateThread}
            onDeletePost={review.onDeletePost}
            onEditPost={review.onEditPost}
            {...(review.onLoadOlder === undefined ? {} : { onLoadOlder: review.onLoadOlder })}
            onModeratePost={review.onModeratePost}
            onNavigateToThread={review.onNavigateToThread}
            onReply={review.onReply}
            onSelectThread={review.onSelectThread}
            onSetThreadStatus={review.onSetThreadStatus}
            saving={review.saving}
            sidebarControlsId="managed-artifact-discussion-sidebar"
            threads={review.threads}
          />
        ) : null}
      </div>
    </div>
  );
});
