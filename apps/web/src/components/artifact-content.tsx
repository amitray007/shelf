// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { Button } from '@cloudflare/kumo/components/button';
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple';
import { FileIcon } from '@phosphor-icons/react/File';
import { FolderIcon } from '@phosphor-icons/react/Folder';
import type { FolderEntry, PublicShareResolution } from '@shelf/contracts';

import { type ViewerAuthority, viewerShareActionUrl } from '../api.js';
import type { PassiveRenderer } from '../rendering.js';
import { prefersSourceView } from '../rendering.js';
import { isFileShareResolution, isFolderShareResolution } from '../share-types.js';
import { DownloadOnlyState } from './download-only-state.js';
import { CodeView, type FileReviewProps, FileView } from './file-view.js';
import { formatFileType } from './format.js';
import { LazyMarkdownView as MarkdownView } from './lazy-views.js';
import { DelimitedTablePreview } from './preview/delimited-table-preview.js';
import { AudioPreview, VideoPreview } from './preview/media-preview.js';
import { DocxPreview } from './preview/office-document-preview.js';
import { pdfJsAdapter } from './preview/pdf-js.js';
import { PdfViewer } from './preview/pdf-viewer.js';
import { StructuredDataPreview } from './preview/structured-data-preview.js';
import { WorkbookPreview } from './preview/workbook-preview.js';
import { RendererFrame } from './renderer-frame.js';

interface ArtifactContentProps {
  readonly resolution: PublicShareResolution;
  readonly renderer: PassiveRenderer;
  readonly text?: string | undefined;
  readonly bytes?: ArrayBuffer | undefined;
  readonly entries?: readonly FolderEntry[];
  readonly previewUrl?: string | undefined;
  readonly downloadUrl?: string;
  readonly authority: ViewerAuthority;
  readonly review?: FileReviewProps | undefined;
  readonly onOpenSidebar?: (() => void) | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly sidebarOpen?: boolean | undefined;
  readonly sidebarLabel?: string | undefined;
}

export function DownloadAction({
  resolution,
  authority,
  compact = false,
}: {
  readonly resolution: Extract<PublicShareResolution, { artifact: { kind: 'file' } }>;
  readonly authority: ViewerAuthority;
  readonly compact?: boolean;
}) {
  const download = () => {
    let action: string;
    try {
      action = viewerShareActionUrl(resolution, authority);
    } catch {
      return;
    }
    const form = document.createElement('form');
    form.action = action;
    form.method = authority.accessType === 'protected' ? 'post' : 'get';
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    if (authority.accessType === 'protected') {
      input.name = 'token';
      input.value = authority.token;
      form.append(input);
    }
    document.body.append(form);
    try {
      form.submit();
    } finally {
      form.remove();
    }
  };
  return (
    <Button
      {...(compact
        ? {
            'aria-label': 'Download',
            title: `Download ${resolution.revision.originalFileName}`,
          }
        : {})}
      icon={DownloadSimpleIcon}
      onClick={download}
      {...(compact ? { size: 'sm' as const } : {})}
      type="button"
      variant="primary"
    >
      {compact ? (
        <span className="file-view-download-label">Download</span>
      ) : (
        `Download ${resolution.revision.originalFileName}`
      )}
    </Button>
  );
}

export function FolderTree({ entries }: { readonly entries: readonly FolderEntry[] }) {
  if (entries.length === 0) {
    return <p className="tree-empty">This folder is empty.</p>;
  }
  return (
    <ul className="folder-tree" aria-label="Folder contents">
      {entries.map((entry) => {
        const segments = entry.path.split('/');
        const name = segments.at(-1) ?? entry.path;
        const depth = Math.max(segments.length - 1, 0);
        return (
          <li
            className={`tree-row tree-row-${entry.kind}`}
            key={`${entry.kind}:${entry.path}`}
            style={{ '--tree-depth': depth } as React.CSSProperties}
          >
            <span className="tree-branch" aria-hidden="true" />
            {entry.kind === 'directory' ? (
              <FolderIcon aria-hidden="true" className="tree-entry-icon" size={16} />
            ) : (
              <FileIcon aria-hidden="true" className="tree-entry-icon" size={16} />
            )}
            <span className="tree-name" title={entry.path}>
              {name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ArtifactContent({
  resolution,
  renderer,
  text,
  bytes,
  entries = [],
  previewUrl,
  downloadUrl,
  authority,
  review,
  onOpenSidebar,
  sidebarControlsId,
  sidebarOpen,
  sidebarLabel,
}: ArtifactContentProps) {
  if (isFolderShareResolution(resolution)) {
    return (
      <section
        aria-label="Artifact folder preview"
        className="artifact-surface artifact-folder"
        tabIndex={0}
      >
        <FolderTree entries={entries} />
      </section>
    );
  }

  if (!isFileShareResolution(resolution)) return null;

  const shareToolbar = {
    download: <DownloadAction authority={authority} compact resolution={resolution} />,
    formatLabel: formatFileType(
      resolution.revision.originalFileName,
      resolution.revision.mediaType,
    ),
  };
  const sidebarProps = {
    ...(onOpenSidebar === undefined ? {} : { onOpenSidebar }),
    ...(sidebarControlsId === undefined ? {} : { sidebarControlsId }),
    ...(sidebarOpen === undefined ? {} : { sidebarOpen }),
    ...(sidebarLabel === undefined ? {} : { sidebarLabel }),
  };

  let preview: React.ReactNode | undefined;
  if (renderer.kind === 'html') {
    preview = (
      <div className="artifact-surface artifact-html">
        <RendererFrame authority={authority} renderer={renderer} resolution={resolution} />
      </div>
    );
  } else if (renderer.kind === 'image' && (previewUrl !== undefined || downloadUrl !== undefined)) {
    preview = (
      <div className="artifact-surface artifact-image">
        <img
          alt={resolution.artifact.name}
          referrerPolicy="no-referrer"
          src={previewUrl ?? downloadUrl}
        />
      </div>
    );
  } else if (renderer.kind === 'markdown' && text !== undefined) {
    preview = (
      <main
        aria-label="Artifact document preview"
        className="artifact-surface artifact-document"
        tabIndex={0}
      >
        <MarkdownView source={text} />
      </main>
    );
  } else if (renderer.kind === 'json' && text !== undefined) {
    preview = (
      <StructuredDataPreview
        fileName={resolution.revision.originalFileName}
        mediaType={resolution.revision.mediaType}
        showFileIdentity={false}
        showModeTabs={false}
        source={text}
      />
    );
  } else if (renderer.kind === 'table' && text !== undefined) {
    preview = (
      <DelimitedTablePreview
        fileName={resolution.revision.originalFileName}
        mediaType={resolution.revision.mediaType}
        showFileIdentity={false}
        showModeTabs={false}
        source={text}
      />
    );
  } else if (renderer.kind === 'docx' && bytes !== undefined) {
    preview = (
      <DocxPreview
        metadata={{
          byteCount: bytes.byteLength,
          fileName: resolution.revision.originalFileName,
          mediaType: resolution.revision.mediaType,
        }}
        src={bytes}
        title={resolution.revision.originalFileName}
      />
    );
  } else if (renderer.kind === 'workbook' && bytes !== undefined) {
    preview = (
      <WorkbookPreview
        metadata={{
          byteCount: bytes.byteLength,
          fileName: resolution.revision.originalFileName,
          format: 'xlsx',
          mediaType: resolution.revision.mediaType,
        }}
        src={bytes}
        showFileIdentity={false}
        title={resolution.revision.originalFileName}
      />
    );
  } else if (renderer.kind === 'text' && text !== undefined) {
    preview = (
      <CodeView
        fileName={resolution.revision.originalFileName}
        label="Artifact source preview"
        source={text}
      />
    );
  } else if (renderer.kind === 'pdf' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-pdf">
        <PdfViewer adapter={pdfJsAdapter} src={previewUrl} title="PDF preview" />
      </div>
    );
  } else if (renderer.kind === 'audio' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-media">
        <AudioPreview
          showFileIdentity={false}
          src={previewUrl}
          title={resolution.revision.originalFileName}
        />
      </div>
    );
  } else if (renderer.kind === 'video' && previewUrl !== undefined) {
    preview = (
      <div className="artifact-surface artifact-media">
        <VideoPreview src={previewUrl} title={resolution.revision.originalFileName} />
      </div>
    );
  }

  if (preview !== undefined || text !== undefined || bytes !== undefined) {
    return (
      <FileView
        {...(text === undefined ? {} : { source: text })}
        defaultMode={
          prefersSourceView(resolution.revision.mediaType, resolution.revision.originalFileName)
            ? 'source'
            : 'preview'
        }
        fileName={resolution.revision.originalFileName}
        key={resolution.revision.revisionId}
        preview={preview}
        review={review}
        shareToolbar={shareToolbar}
        {...sidebarProps}
      />
    );
  }
  if (renderer.kind === 'download' || preview === undefined) {
    return (
      <FileView
        fileName={resolution.revision.originalFileName}
        preview={
          <div className="artifact-surface artifact-download">
            <DownloadOnlyState
              fileName={resolution.revision.originalFileName}
              mediaType={resolution.revision.mediaType}
            />
          </div>
        }
        shareToolbar={shareToolbar}
        {...sidebarProps}
      />
    );
  }
  return null;
}
