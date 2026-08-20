// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { LinkButton } from '@cloudflare/kumo/components/button';
import { FileArrowDownIcon } from '@phosphor-icons/react/FileArrowDown';
import type {
  Artifact,
  ArtifactRevision,
  CommentAnchor,
  CommentThread,
  FolderEntry,
} from '@shelf/contracts';
import { memo, useCallback, useEffect, useMemo } from 'react';

import { CodeView, decodeFileSource, FileView, formatJson } from '../components/file-view.js';
import { FolderBrowser } from '../components/folder-browser.js';
import { MarkdownView } from '../components/markdown-view.js';
import { DiscussionPanel } from '../components/review/discussion-panel.js';
import type { ReviewSidebarMode } from '../components/review/types.js';
import { normalizeMediaType, selectRenderer, supportsSourceView } from '../rendering.js';
import { loadFolderEntryBytes } from './api.js';

export interface ManagedArtifactReview {
  readonly moderator?: boolean | undefined;
  readonly canCreateThread: boolean;
  readonly revisionId: string;
  readonly threads: readonly CommentThread[];
  readonly activeThreadId?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly loadingOlder?: boolean | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly mode?: ReviewSidebarMode | undefined;
  readonly onModeChange?: ((mode: ReviewSidebarMode) => void) | undefined;
  readonly onSelectThread: (threadId: string) => void;
  readonly onLoadOlder?: (() => Promise<void>) | undefined;
  readonly onCreateThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onSetThreadStatus: (threadId: string, status: 'resolve' | 'reopen') => Promise<void>;
  readonly onModeratePost?:
    | ((postId: string, moderation: 'hide' | 'unhide') => Promise<void>)
    | undefined;
}

function DownloadOnly({ revision }: { readonly revision: ArtifactRevision }) {
  if (revision.kind !== 'file') return null;
  return (
    <section className="empty-state managed-download" aria-labelledby="managed-download-title">
      <FileArrowDownIcon aria-hidden="true" className="managed-download-icon" size={30} />
      <p className="managed-download-type">{revision.mediaType}</p>
      <h2 id="managed-download-title">Download-only format</h2>
      <p>Active or unsupported content is not executed on the authenticated Shelf origin.</p>
      <LinkButton href={revision.paths.content} icon={FileArrowDownIcon} variant="primary">
        Download {revision.originalFileName}
      </LinkButton>
    </section>
  );
}

export const ManagedArtifactContent = memo(function ManagedArtifactContent({
  artifact,
  revision,
  bytes,
  entries,
  review,
  discussionOpen = false,
  onDiscussionToggle,
}: {
  readonly artifact: Artifact;
  readonly revision: ArtifactRevision;
  readonly bytes: ArrayBuffer | null;
  readonly entries: readonly FolderEntry[];
  readonly review?: ManagedArtifactReview | undefined;
  readonly discussionOpen?: boolean | undefined;
  readonly onDiscussionToggle?: (() => void) | undefined;
}) {
  const renderer =
    revision.kind === 'file'
      ? selectRenderer(revision.mediaType, undefined)
      : { kind: 'download' as const };
  const normalizedMediaType =
    revision.kind === 'file' ? normalizeMediaType(revision.mediaType) : '';
  const source =
    revision.kind === 'file' && bytes !== null && supportsSourceView(revision.mediaType)
      ? decodeFileSource(bytes)
      : null;
  const imageUrl = useMemo(
    () =>
      revision.kind === 'file' &&
      (renderer.kind === 'image' || normalizedMediaType === 'image/svg+xml') &&
      bytes !== null
        ? URL.createObjectURL(new Blob([bytes], { type: revision.mediaType }))
        : undefined,
    [bytes, normalizedMediaType, renderer.kind, revision],
  );
  useEffect(
    () => () => {
      if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
  const loadFolderFile = useCallback(
    (path: string, signal: AbortSignal) => loadFolderEntryBytes(revision.revisionId, path, signal),
    [revision.revisionId],
  );

  if (revision.kind === 'folder') {
    return (
      <FolderBrowser
        entries={entries}
        loadFile={loadFolderFile}
        {...(review === undefined
          ? {}
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
  if (bytes === null) {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly revision={revision} />
      </div>
    );
  }
  let preview: React.ReactNode | undefined;
  if (renderer.kind === 'image' || normalizedMediaType === 'image/svg+xml') {
    preview = (
      <div className="artifact-surface artifact-image">
        {imageUrl === undefined ? null : (
          <img alt={artifact.name} referrerPolicy="no-referrer" src={imageUrl} />
        )}
      </div>
    );
  } else if (renderer.kind === 'markdown' && source !== null) {
    preview = (
      <section
        aria-label="Artifact document preview"
        className="artifact-surface artifact-document"
        tabIndex={0}
      >
        <MarkdownView source={source} />
      </section>
    );
  } else if (renderer.kind === 'json' && source !== null) {
    preview = (
      <CodeView
        fileName={revision.originalFileName}
        label="Artifact data preview"
        source={formatJson(source)}
      />
    );
  }
  if (preview === undefined && source === null) {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly revision={revision} />
      </div>
    );
  }
  return (
    <div className="managed-file-review-stage">
      {review && onDiscussionToggle ? (
        <div className="managed-discussion-toolbar">
          <button
            aria-expanded={discussionOpen}
            className="review-button review-button-quiet"
            onClick={onDiscussionToggle}
            type="button"
          >
            {discussionOpen ? 'Hide discussion' : 'Discussion'}
            {review.threads.length > 0 ? ` · ${review.threads.length}` : ''}
          </button>
        </div>
      ) : null}
      <div className="managed-file-preview">
        <FileView
          {...(source === null ? {} : { source })}
          {...(review === undefined
            ? {}
            : {
                review: {
                  canCreateThread: false,
                  revisionId: review.revisionId,
                  threads: review.threads,
                  onCreateThread: review.onCreateThread,
                  onSelectThread: review.onSelectThread,
                },
              })}
          fileName={revision.originalFileName}
          key={revision.revisionId}
          preview={preview}
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
          {...(review.onLoadOlder === undefined ? {} : { onLoadOlder: review.onLoadOlder })}
          onModeratePost={review.onModeratePost}
          onReply={review.onReply}
          onSelectThread={review.onSelectThread}
          onSetThreadStatus={review.onSetThreadStatus}
          saving={review.saving}
          threads={review.threads}
        />
      ) : null}
    </div>
  );
});
