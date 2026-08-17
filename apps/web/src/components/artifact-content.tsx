import type { FolderEntry, PublicShareResolution } from '@shelf/contracts';

import { publicShareActionUrl } from '../api.js';
import { capabilityStorageKey, isShareCapability } from '../capability.js';
import type { PassiveRenderer } from '../rendering.js';
import { isFileShareResolution, isFolderShareResolution } from '../share-types.js';
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
    <button className="button button-primary" onClick={download} type="button">
      Download {resolution.revision.originalFileName}
    </button>
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
    <section className="empty-state" aria-labelledby="download-title">
      <span className="file-glyph" aria-hidden="true" />
      <p className="eyebrow">{mediaType}</p>
      <h1 id="download-title">Preview unavailable</h1>
      <p>This format stays download-only to keep active content outside Shelf.</p>
      <DownloadAction resolution={resolution} />
    </section>
  );
}

function FolderTree({ entries }: { readonly entries: readonly FolderEntry[] }) {
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
            <span className="tree-icon" aria-hidden="true" />
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

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} kB`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
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
      <div className="artifact-surface artifact-folder">
        <FolderTree entries={entries} />
      </div>
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
      <main className="artifact-surface artifact-document">
        <MarkdownView source={text} />
      </main>
    );
  }
  return (
    <main className="artifact-surface artifact-code">
      <pre>
        <code>{renderer.kind === 'json' ? formatJson(text) : text}</code>
      </pre>
    </main>
  );
}
