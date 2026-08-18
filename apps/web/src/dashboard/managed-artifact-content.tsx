// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable previews must be keyboard reachable.

import { LinkButton } from '@cloudflare/kumo/components/button';
import { FileArrowDownIcon } from '@phosphor-icons/react/FileArrowDown';
import type { Artifact, ArtifactRevision, FolderEntry } from '@shelf/contracts';
import { memo, useEffect, useMemo } from 'react';

import { FolderTree, formatJson } from '../components/artifact-content.js';
import { MarkdownView } from '../components/markdown-view.js';
import { selectRenderer } from '../rendering.js';

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
}: {
  readonly artifact: Artifact;
  readonly revision: ArtifactRevision;
  readonly bytes: ArrayBuffer | null;
  readonly entries: readonly FolderEntry[];
}) {
  const renderer =
    revision.kind === 'file'
      ? selectRenderer(revision.mediaType, undefined)
      : { kind: 'download' as const };
  const imageUrl = useMemo(
    () =>
      revision.kind === 'file' && renderer.kind === 'image' && bytes !== null
        ? URL.createObjectURL(new Blob([bytes], { type: revision.mediaType }))
        : undefined,
    [bytes, renderer.kind, revision],
  );
  useEffect(
    () => () => {
      if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  if (revision.kind === 'folder') {
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
  if (renderer.kind === 'download' || bytes === null) {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly revision={revision} />
      </div>
    );
  }
  if (renderer.kind === 'image') {
    return (
      <div className="artifact-surface artifact-image">
        {imageUrl === undefined ? null : <img alt={artifact.name} src={imageUrl} />}
      </div>
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return (
      <div className="artifact-surface artifact-download">
        <DownloadOnly revision={revision} />
      </div>
    );
  }
  if (renderer.kind === 'markdown') {
    return (
      <section
        aria-label="Artifact document preview"
        className="artifact-surface artifact-document"
        tabIndex={0}
      >
        <MarkdownView source={text} />
      </section>
    );
  }
  return (
    <section
      aria-label="Artifact code preview"
      className="artifact-surface artifact-code"
      tabIndex={0}
    >
      <pre tabIndex={0}>
        <code>{renderer.kind === 'json' ? formatJson(text) : text}</code>
      </pre>
    </section>
  );
});
