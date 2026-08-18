import type { FolderEntry, PublicShareResolution } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactContent } from '../src/components/artifact-content.js';
import { UnavailableView, ViewerRail } from '../src/components/viewer-shell.js';

const FILE_RESOLUTION = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  target: { mode: 'latest' },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'idea.md' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 3,
    createdAt: '2026-08-18T10:00:00.000Z',
    kind: 'file',
    originalFileName: 'idea.md',
    mediaType: 'text/markdown',
    byteCount: 42,
  },
  action: {
    type: 'content',
    path: `/api/v1/public/shares/shr_${'a'.repeat(22)}/content`,
  },
} satisfies PublicShareResolution;

const FOLDER_RESOLUTION = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  target: { mode: 'pinned', revisionId: `rev_${'c'.repeat(22)}` },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'folder', name: 'ideas' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 3,
    createdAt: '2026-08-18T10:00:00.000Z',
    kind: 'folder',
    rootName: 'ideas',
    byteCount: 42,
    fileCount: 1,
  },
  action: {
    type: 'tree',
    path: `/api/v1/public/shares/shr_${'a'.repeat(22)}/tree`,
  },
} satisfies PublicShareResolution;

function renderContent(props: Partial<React.ComponentProps<typeof ArtifactContent>> = {}): string {
  return renderToStaticMarkup(
    <ArtifactContent
      resolution={FILE_RESOLUTION}
      renderer={{ kind: 'text' }}
      text={'const idea = "keep";'}
      downloadUrl="blob:test"
      {...props}
    />,
  );
}

describe('viewer content states', () => {
  it('renders escaped text and formatted JSON', () => {
    const text = renderContent({ text: '<script>unsafe</script>' });
    expect(text).toContain('&lt;script&gt;');
    expect(text.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(renderContent({ renderer: { kind: 'json' }, text: '{"name":"shelf"}' })).toContain(
      '&quot;name&quot;: &quot;shelf&quot;',
    );
  });

  it('renders an allowlisted raster image without embedding active markup', () => {
    const html = renderContent({ renderer: { kind: 'image' } });
    expect(html).toContain('<img');
    expect(html).toContain('src="blob:test"');
  });

  it('renders folder entries as a browsable tree', () => {
    const entries: FolderEntry[] = [
      { kind: 'directory', path: 'notes' },
      {
        kind: 'file',
        path: 'notes/idea.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'d'.repeat(64)}`,
        byteCount: 42,
      },
    ];
    const html = renderContent({ entries, resolution: FOLDER_RESOLUTION });
    expect(html).toContain('notes');
    expect(html).toContain('idea.md');
    expect(html).toContain('<svg');
    expect(html).not.toContain('tree-icon');
  });

  it('gives download-only files a clear quiet state', () => {
    const html = renderContent({ renderer: { kind: 'download' } });
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('Download idea.md');
  });

  it('uses the same unavailable projection for every failed public lookup', () => {
    const html = renderToStaticMarkup(<UnavailableView />);
    expect(html).toContain('This artifact is unavailable');
    expect(html).not.toMatch(/revoked|expired|secret|permission/i);
  });

  it('presents a compact artifact map without decorative trust indicators', () => {
    const html = renderToStaticMarkup(<ViewerRail resolution={FILE_RESOLUTION} />);

    expect(html).toContain('Shared artifact');
    expect(html).toContain('idea.md');
    expect(html).not.toContain('trust-dot');
  });
});
