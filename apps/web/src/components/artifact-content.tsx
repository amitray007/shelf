// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { Button } from '@cloudflare/kumo/components/button';
import { Empty } from '@cloudflare/kumo/components/empty';
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple';
import { FileIcon } from '@phosphor-icons/react/File';
import { FileDashedIcon } from '@phosphor-icons/react/FileDashed';
import { FolderIcon } from '@phosphor-icons/react/Folder';
import type { FolderEntry, PublicShareResolution } from '@shelf/contracts';

import { type ViewerAuthority, viewerShareActionUrl } from '../api.js';
import { normalizeMediaType, type PassiveRenderer } from '../rendering.js';
import { isFileShareResolution, isFolderShareResolution } from '../share-types.js';
import { CodeView, type FileReviewProps, FileView, formatJson } from './file-view.js';
import { formatBytes } from './format.js';
import { MarkdownView } from './markdown-view.js';
import { RendererFrame } from './renderer-frame.js';

interface ArtifactContentProps {
  readonly resolution: PublicShareResolution;
  readonly renderer: PassiveRenderer;
  readonly text?: string | undefined;
  readonly entries?: readonly FolderEntry[];
  readonly downloadUrl?: string;
  readonly authority: ViewerAuthority;
  readonly review?: FileReviewProps | undefined;
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
      icon={DownloadSimpleIcon}
      onClick={download}
      {...(compact ? { size: 'sm' as const } : {})}
      type="button"
      variant="primary"
    >
      {compact ? 'Download' : `Download ${resolution.revision.originalFileName}`}
    </Button>
  );
}

function DownloadOnly({
  mediaType,
  resolution,
  authority,
}: {
  readonly mediaType: string;
  readonly resolution: Extract<PublicShareResolution, { artifact: { kind: 'file' } }>;
  readonly authority: ViewerAuthority;
}) {
  return (
    <Empty
      className="download-empty"
      contents={<DownloadAction authority={authority} resolution={resolution} />}
      description={`This ${mediaType} artifact stays download-only to keep active content outside Shelf.`}
      icon={<FileDashedIcon aria-hidden="true" size={32} />}
      size="sm"
      title="Preview unavailable"
    />
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
            {entry.kind === 'file' && (
              <span className="tree-meta">
                {entry.mediaType} · {formatBytes(entry.byteCount)}
              </span>
            )}
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
  entries = [],
  downloadUrl,
  authority,
  review,
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

  const normalizedMediaType = normalizeMediaType(resolution.revision.mediaType);
  let preview: React.ReactNode | undefined;
  if (renderer.kind === 'html') {
    preview = (
      <div className="artifact-surface artifact-html">
        <RendererFrame authority={authority} renderer={renderer} resolution={resolution} />
      </div>
    );
  } else if (renderer.kind === 'image' || normalizedMediaType === 'image/svg+xml') {
    preview = (
      <div className="artifact-surface artifact-image">
        {downloadUrl === undefined ? null : (
          <img alt={resolution.artifact.name} referrerPolicy="no-referrer" src={downloadUrl} />
        )}
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
      <CodeView
        fileName={resolution.revision.originalFileName}
        label="Artifact data preview"
        source={formatJson(text)}
      />
    );
  }

  if (preview !== undefined || text !== undefined) {
    return (
      <FileView
        {...(text === undefined ? {} : { source: text })}
        fileName={resolution.revision.originalFileName}
        key={resolution.revision.revisionId}
        preview={preview}
        review={review}
      />
    );
  }
  if (renderer.kind === 'download') {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly
          authority={authority}
          mediaType={resolution.revision.mediaType}
          resolution={resolution}
        />
      </div>
    );
  }
  return null;
}
