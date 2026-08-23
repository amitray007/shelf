import type { ArtifactRevision, PublicShareResolution } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { viewerSharePreviewUrl } from '../src/api.js';
import { ArtifactFileView } from '../src/components/artifact-file-view.js';
import { ViewerRail } from '../src/components/viewer-shell.js';
import { ManagedArtifactContent } from '../src/dashboard/managed-artifact-content.js';
import { selectRenderer } from '../src/rendering.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const REVISION_ID = `rev_${'b'.repeat(22)}`;
const resolution = {
  apiVersion: 'v1',
  shareId: SHARE_ID,
  accessType: 'protected',
  target: { mode: 'latest' },
  expiresAt: null,
  artifact: { artifactId: `art_${'c'.repeat(22)}`, kind: 'file', name: 'preview.bin' },
  revision: {
    revisionId: REVISION_ID,
    revisionNumber: 1,
    createdAt: '2026-08-23T00:00:00.000Z',
    kind: 'file',
    originalFileName: 'preview.bin',
    mediaType: 'application/octet-stream',
    byteCount: 12,
  },
  action: { type: 'content', path: `/api/v1/public/shares/${SHARE_ID}/content` },
} satisfies PublicShareResolution;

const authority = {
  accessType: 'protected' as const,
  shareId: SHARE_ID,
  sessionId: '123e4567-e89b-42d3-a456-426614174000',
  token: 'visitor-token-secret',
};

const managedRevision = {
  contentHash: `sha256:${'d'.repeat(64)}`,
  createdAt: '2026-08-23T00:00:00.000Z',
  fileCount: 1,
  kind: 'file',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  originalFileName: 'release.docx',
  paths: {
    content: `/api/v1/revisions/${REVISION_ID}/content`,
    revision: `/api/v1/revisions/${REVISION_ID}`,
  },
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-owner', operation: 'file.publish' },
  },
  publisherMetadata: {},
  revisionId: REVISION_ID,
  revisionNumber: 1,
  byteCount: 8,
} satisfies ArtifactRevision;

describe('web preview integration', () => {
  it.each([
    ['image/svg+xml', 'image', undefined, '/api/v1/revisions/svg/preview', '<img'],
    ['text/markdown', 'markdown', '# hello', undefined, 'Preview'],
    ['application/json', 'json', '{"ready":true}', undefined, 'structured-data-preview'],
    ['text/csv', 'table', 'name\nShelf', undefined, 'delimited-table-preview'],
    ['application/pdf', 'pdf', undefined, '/api/v1/revisions/pdf/preview', 'PDF preview'],
    ['audio/mpeg', 'audio', undefined, '/api/v1/revisions/audio/preview', '<audio'],
    ['video/mp4', 'video', undefined, '/api/v1/revisions/video/preview', '<video'],
  ] as const)(
    'renders %s through the shared surface',
    (mediaType, kind, text, previewUrl, marker) => {
      const renderer = selectRenderer(
        mediaType,
        undefined,
        `preview.${mediaType === 'text/csv' ? 'csv' : 'bin'}`,
      );
      expect(renderer.kind).toBe(kind);
      const markup = renderToStaticMarkup(
        <ArtifactFileView
          capabilities={{ download: () => undefined }}
          content={{
            status: 'ready',
            ...(text === undefined ? {} : { bytes: new TextEncoder().encode(text).buffer }),
            ...(previewUrl === undefined ? {} : { previewUrl }),
          }}
          file={{
            id: `file:${mediaType}`,
            mediaType,
            name: `preview.${mediaType === 'text/csv' ? 'csv' : 'bin'}`,
          }}
        />,
      );
      expect(markup).toContain(marker);
    },
  );

  it.each([
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'release.docx',
      'docx',
      'data-preview-kind="docx"',
    ],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'budget.xlsx',
      'workbook',
      'data-preview-kind="workbook"',
    ],
  ] as const)('renders %s in the shared protected surface', (mediaType, fileName, kind, marker) => {
    const renderer = selectRenderer(mediaType, undefined, fileName);
    expect(renderer).toEqual({ kind });
    const markup = renderToStaticMarkup(
      <ArtifactFileView
        capabilities={{ download: () => undefined }}
        content={{ bytes: new ArrayBuffer(8), status: 'ready' }}
        file={{ id: `file:${fileName}`, mediaType, name: fileName }}
      />,
    );
    expect(markup).toContain(marker);
    expect(markup).not.toContain(authority.token);
  });

  it('renders the same DOCX binding in the authenticated artifact surface', () => {
    const markup = renderToStaticMarkup(
      <ManagedArtifactContent bytes={new ArrayBuffer(8)} entries={[]} revision={managedRevision} />,
    );
    expect(markup).toContain('data-preview-kind="docx"');
    expect(markup).toContain('Download');
  });

  it('keeps shared structured and table controls owned by the rail and outer file view', () => {
    for (const [mediaType, fileName, text] of [
      ['application/yaml', 'config.yaml', 'name: Shelf'],
      ['text/csv', 'data.csv', 'name\nShelf'],
    ] as const) {
      const sharedResolution = {
        ...resolution,
        revision: { ...resolution.revision, mediaType, originalFileName: fileName },
      };
      const markup = renderToStaticMarkup(
        <>
          <ViewerRail authority={authority} resolution={sharedResolution} />
          <ArtifactFileView
            capabilities={{ download: () => undefined }}
            content={{ bytes: new TextEncoder().encode(text).buffer, status: 'ready' }}
            file={{ id: `file:${fileName}`, mediaType, name: fileName }}
          />
        </>,
      );

      expect((markup.match(/role="tablist"/gu) ?? []).length).toBe(1);
      expect((markup.match(/>Preview</gu) ?? []).length).toBe(1);
      expect((markup.match(/>Source</gu) ?? []).length).toBe(1);
      expect((markup.match(/>Download</gu) ?? []).length).toBe(1);
    }
  });

  it('keeps protected preview URLs capability-free', () => {
    const url = viewerSharePreviewUrl(resolution, authority);
    expect(url).toBe(`/api/v1/public/shares/${SHARE_ID}/content/preview`);
    expect(url).not.toContain(authority.token);
  });
});
