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
import { memo, useCallback, useState } from 'react';

import { CodeView, decodeFileSource, FileView } from '../components/file-view.js';
import {
  LazyFolderBrowser as FolderBrowser,
  LazyMarkdownView as MarkdownView,
} from '../components/lazy-views.js';
import { DelimitedTablePreview } from '../components/preview/delimited-table-preview.js';
import { AudioPreview, VideoPreview } from '../components/preview/media-preview.js';
import { DocxPreview } from '../components/preview/office-document-preview.js';
import { pdfJsAdapter } from '../components/preview/pdf-js.js';
import { PdfViewer } from '../components/preview/pdf-viewer.js';
import { StructuredDataPreview } from '../components/preview/structured-data-preview.js';
import { WorkbookPreview } from '../components/preview/workbook-preview.js';
import { DiscussionPanel } from '../components/review/discussion-panel.js';
import type { ReviewSidebarMode } from '../components/review/types.js';
import {
  requiresClientBytes,
  selectRenderer,
  supportsSourceView,
  usesPreviewUrl,
} from '../rendering.js';
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

function DownloadAction({ revision }: { readonly revision: ArtifactRevision }) {
  if (revision.kind !== 'file') return null;
  return (
    <div className="artifact-preview-action">
      <LinkButton
        href={revision.paths.content}
        icon={FileArrowDownIcon}
        size="sm"
        variant="primary"
      >
        Download
      </LinkButton>
    </div>
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
      ? selectRenderer(revision.mediaType, undefined, revision.originalFileName)
      : { kind: 'download' as const };
  const source =
    revision.kind === 'file' &&
    bytes !== null &&
    renderer.kind !== 'docx' &&
    renderer.kind !== 'workbook' &&
    (requiresClientBytes(renderer) ||
      supportsSourceView(revision.mediaType, revision.originalFileName))
      ? decodeFileSource(bytes)
      : null;
  const previewUrl =
    revision.kind === 'file' && usesPreviewUrl(renderer)
      ? revisionPreviewUrl(revision.revisionId)
      : undefined;
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
          : {})}
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
  if (bytes === null && (renderer.kind === 'download' || requiresClientBytes(renderer))) {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly revision={revision} />
      </div>
    );
  }
  let preview: React.ReactNode | undefined;
  if (renderer.kind === 'image' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <div className="artifact-surface artifact-image">
          <img alt={artifact.name} referrerPolicy="no-referrer" src={previewUrl} />
        </div>
      </div>
    );
  } else if (renderer.kind === 'markdown' && source !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <section
          aria-label="Artifact document preview"
          className="artifact-surface artifact-document"
          tabIndex={0}
        >
          <MarkdownView source={source} />
        </section>
      </div>
    );
  } else if (renderer.kind === 'json' && source !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <StructuredDataPreview
          fileName={revision.originalFileName}
          mediaType={revision.mediaType}
          showModeTabs={false}
          source={source}
        />
      </div>
    );
  } else if (renderer.kind === 'table' && source !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <DelimitedTablePreview
          fileName={revision.originalFileName}
          mediaType={revision.mediaType}
          showModeTabs={false}
          source={source}
        />
      </div>
    );
  } else if (renderer.kind === 'docx' && bytes !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <DocxPreview
          metadata={{
            byteCount: bytes.byteLength,
            fileName: revision.originalFileName,
            mediaType: revision.mediaType,
          }}
          src={bytes}
          title={revision.originalFileName}
        />
      </div>
    );
  } else if (renderer.kind === 'workbook' && bytes !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <WorkbookPreview
          metadata={{
            byteCount: bytes.byteLength,
            fileName: revision.originalFileName,
            format: 'xlsx',
            mediaType: revision.mediaType,
          }}
          src={bytes}
          title={revision.originalFileName}
        />
      </div>
    );
  } else if (renderer.kind === 'text' && source !== null) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <CodeView
          fileName={revision.originalFileName}
          label="Artifact source preview"
          source={source}
        />
      </div>
    );
  } else if (renderer.kind === 'pdf' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <div className="artifact-surface artifact-pdf">
          <PdfViewer adapter={pdfJsAdapter} src={previewUrl} title="PDF preview" />
        </div>
      </div>
    );
  } else if (renderer.kind === 'audio' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <div className="artifact-surface artifact-media">
          <AudioPreview src={previewUrl} title={revision.originalFileName} />
        </div>
      </div>
    );
  } else if (renderer.kind === 'video' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-preview-with-download">
        <DownloadAction revision={revision} />
        <div className="artifact-surface artifact-media">
          <VideoPreview src={previewUrl} title={revision.originalFileName} />
        </div>
      </div>
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
      <div className="managed-file-review-body">
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
            fileName={revision.originalFileName}
            key={revision.revisionId}
            preview={preview}
            {...(review === undefined || onDiscussionToggle === undefined
              ? {}
              : {
                  onOpenSidebar: onDiscussionToggle,
                  sidebarControlsId: 'managed-artifact-discussion-sidebar',
                  sidebarLabel: 'discussions sidebar',
                  sidebarOpen: discussionOpen,
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
