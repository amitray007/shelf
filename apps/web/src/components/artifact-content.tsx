// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { Button } from '@cloudflare/kumo/components/button';
import { Empty } from '@cloudflare/kumo/components/empty';
import { DownloadSimpleIcon } from '@phosphor-icons/react/DownloadSimple';
import { FileIcon } from '@phosphor-icons/react/File';
import { FileDashedIcon } from '@phosphor-icons/react/FileDashed';
import { FolderIcon } from '@phosphor-icons/react/Folder';
import type { FolderEntry, PublicShareResolution } from '@shelf/contracts';

import { publicShareActionUrl } from '../api.js';
import { capabilityStorageKey, isShareCapability } from '../capability.js';
import type { PassiveRenderer } from '../rendering.js';
import { isFileShareResolution, isFolderShareResolution } from '../share-types.js';
import { formatBytes } from './format.js';
import { MarkdownView } from './markdown-view.js';
import { RendererFrame } from './renderer-frame.js';

interface ArtifactContentProps {
  readonly resolution: PublicShareResolution;
  readonly renderer: PassiveRenderer;
  readonly text?: string;
  readonly entries?: readonly FolderEntry[];
  readonly downloadUrl?: string;
}

function DownloadAction({
  resolution,
}: {
  readonly resolution: Extract<PublicShareResolution, { artifact: { kind: 'file' } }>;
}) {
  const download = () => {
    let secret: string | null = null;
    try {
      secret = window.sessionStorage.getItem(capabilityStorageKey(resolution.shareId));
    } catch {
      return;
    }
    if (secret === null || !isShareCapability(secret)) return;
    let action: string;
    try {
      action = publicShareActionUrl(resolution.action.path);
    } catch {
      return;
    }
    const form = document.createElement('form');
    form.action = action;
    form.method = 'post';
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'secret';
    input.value = secret;
    form.append(input);
    document.body.append(form);
    try {
      form.submit();
    } finally {
      form.remove();
    }
  };
  return (
    <Button icon={DownloadSimpleIcon} onClick={download} type="button" variant="primary">
      Download {resolution.revision.originalFileName}
    </Button>
  );
}

function DownloadOnly({
  mediaType,
  resolution,
}: {
  readonly mediaType: string;
  readonly resolution: Extract<PublicShareResolution, { artifact: { kind: 'file' } }>;
}) {
  return (
    <Empty
      className="download-empty"
      contents={<DownloadAction resolution={resolution} />}
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

export function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function ArtifactContent({
  resolution,
  renderer,
  text = '',
  entries = [],
  downloadUrl,
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

  if (renderer.kind === 'html') {
    return (
      <div className="artifact-surface artifact-html">
        <RendererFrame renderer={renderer} resolution={resolution} />
        <div className="renderer-download">
          <DownloadAction resolution={resolution} />
        </div>
      </div>
    );
  }
  if (renderer.kind === 'download') {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly mediaType={resolution.revision.mediaType} resolution={resolution} />
      </div>
    );
  }
  if (renderer.kind === 'image') {
    return (
      <div className="artifact-surface artifact-image">
        {downloadUrl === undefined ? null : (
          <img alt={resolution.artifact.name} src={downloadUrl} />
        )}
      </div>
    );
  }
  if (renderer.kind === 'markdown') {
    return (
      <main
        aria-label="Artifact document preview"
        className="artifact-surface artifact-document"
        tabIndex={0}
      >
        <MarkdownView source={text} />
      </main>
    );
  }
  return (
    <main
      aria-label="Artifact code preview"
      className="artifact-surface artifact-code"
      tabIndex={0}
    >
      <pre>
        <code>{renderer.kind === 'json' ? formatJson(text) : text}</code>
      </pre>
    </main>
  );
}
