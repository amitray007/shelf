import type { ArtifactRevision } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactFileView } from '../src/components/artifact-file-view.js';
import { FileLoadingState } from '../src/components/file-view.js';
import {
  AudioPreview,
  DelimitedTablePreview,
  DocxPreview,
  ImagePreview,
  PdfPreview,
  StructuredDataPreview,
  VideoPreview,
  WorkbookPreview,
} from '../src/components/lazy-file-previews.js';
import { LazyMarkdownProperties, LazyMarkdownView } from '../src/components/lazy-views.js';
import { ViewerControls } from '../src/components/viewer-controls.js';
import { ManagedArtifactContent } from '../src/dashboard/managed-artifact-content.js';

const previews = {
  AudioPreview,
  DelimitedTablePreview,
  DocxPreview,
  ImagePreview,
  PdfPreview,
  StructuredDataPreview,
  VideoPreview,
  WorkbookPreview,
};
const cases = [
  ['ImagePreview', 'image/png', 'image.png', '', '<img'],
  [
    'StructuredDataPreview',
    'application/json',
    'data.json',
    '{"ready":true}',
    'structured-data-preview',
  ],
  ['DelimitedTablePreview', 'text/csv', 'data.csv', 'name\nShelf', 'delimited-table-preview'],
  ['DocxPreview', 'application/octet-stream', 'document.docx', '', 'data-preview-kind="docx"'],
  ['WorkbookPreview', 'application/octet-stream', 'book.xlsx', '', 'data-preview-kind="workbook"'],
  ['PdfPreview', 'application/pdf', 'document.pdf', '', 'pdf-viewer'],
  ['AudioPreview', 'audio/mpeg', 'audio.mp3', '', '<audio'],
  ['VideoPreview', 'video/mp4', 'video.mp4', '', '<video'],
] as const;

describe('artifact lazy preview paths', () => {
  it.each(cases)('loads and renders %s', async (key, mediaType, name, source, marker) => {
    const render = () =>
      renderToStaticMarkup(
        <ArtifactFileView
          content={{
            status: 'ready',
            bytes: new TextEncoder().encode(source).buffer,
            previewUrl: '/safe-preview',
          }}
          file={{ id: name, name, mediaType }}
        />,
      );
    expect(render()).toContain(renderToStaticMarkup(<FileLoadingState />));
    expect(render()).not.toContain('<template');
    await previews[key].preload();
    expect(render()).toContain(marker);
    expect(render()).not.toContain('This file could not be loaded.');
  });

  it('loads Markdown and its document properties together', async () => {
    await Promise.all([LazyMarkdownView.preload(), LazyMarkdownProperties.preload()]);
    const markup = renderToStaticMarkup(
      <ViewerControls actions={null} title="Release">
        <ArtifactFileView
          content={{
            status: 'ready',
            bytes: new TextEncoder().encode('---\ntitle: Release\n---\n# Ready').buffer,
          }}
          file={{ id: 'markdown', name: 'release.md', mediaType: 'text/markdown' }}
        />
      </ViewerControls>,
    );
    expect(markup).toContain('<h1>Ready</h1>');
    expect(markup).not.toContain('Opening artifact');
  });

  it('keeps the owner dashboard DOCX preview working after loading its module', async () => {
    await previews.DocxPreview.preload();
    const revision = {
      contentHash: `sha256:${'d'.repeat(64)}`,
      createdAt: '2026-10-30T00:00:00.000Z',
      fileCount: 1,
      kind: 'file',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFileName: 'release.docx',
      paths: { content: '/content', revision: '/revision' },
      provenance: {
        classification: 'direct-publish',
        observed: { actorId: 'owner', operation: 'file.publish' },
      },
      publisherMetadata: {},
      revisionId: `rev_${'b'.repeat(22)}`,
      revisionNumber: 1,
      byteCount: 8,
    } satisfies ArtifactRevision;
    const markup = renderToStaticMarkup(
      <ManagedArtifactContent bytes={new ArrayBuffer(8)} entries={[]} revision={revision} />,
    );
    expect(markup).toContain('data-preview-kind="docx"');
    expect(markup).toContain('Download');
  });
});
