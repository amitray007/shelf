import type { ArtifactRevision, FolderEntry } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactFileView } from '../src/components/artifact-file-view.js';
import { classifyDownloadOnly, DownloadOnlyState } from '../src/components/download-only-state.js';
import { FolderBrowser } from '../src/components/folder-browser.js';
import { ManagedArtifactContent } from '../src/dashboard/managed-artifact-content.js';
import { shouldLoadManagedRevisionBytes } from '../src/dashboard/routes.js';
import { selectRenderer, supportsSourceView } from '../src/rendering.js';

const managedHtmlRevision = {
  contentHash: `sha256:${'e'.repeat(64)}`,
  createdAt: '2026-08-24T00:00:00.000Z',
  fileCount: 1,
  kind: 'file',
  mediaType: 'text/html',
  originalFileName: 'index.html',
  paths: {
    content: '/api/v1/revisions/rev_html/content',
    revision: '/api/v1/revisions/rev_html',
  },
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-owner', operation: 'file.publish' },
  },
  publisherMetadata: {},
  revisionId: 'rev_html',
  revisionNumber: 1,
  byteCount: 38,
} satisfies ArtifactRevision;

describe('public download-only state', () => {
  it.each([
    ['archive.zip', 'application/octet-stream', 'archive'],
    ['font.ttf', 'application/octet-stream', 'font'],
    ['font.woff2', 'font/woff2', 'font'],
    ['payload.bin', 'application/octet-stream', 'binary'],
    ['payload.dat', 'application/octet-stream', 'binary'],
    ['legacy.doc', 'application/msword', 'office'],
    ['legacy.xls', 'application/octet-stream', 'office'],
    ['legacy.ppt', 'application/octet-stream', 'office'],
    ['deck.pptx', 'application/octet-stream', 'office'],
    ['unknown.data', 'application/x-custom-binary', 'generic'],
  ] as const)('classifies %s as %s', (fileName, mediaType, category) => {
    expect(classifyDownloadOnly(fileName, mediaType)).toBe(category);
  });

  it.each([
    ['archive.zip', 'application/octet-stream', 'Download the archive to open its contents.'],
    ['font.ttf', 'font/ttf', 'Download the font to install or use it.'],
    [
      'payload.bin',
      'application/octet-stream',
      'Download this file to open it with a compatible app.',
    ],
    ['legacy.doc', 'application/msword', 'Download this file to open it in an Office app.'],
    ['unknown.data', 'application/x-custom-binary', 'Download this file to open it.'],
  ] as const)('uses the required copy for %s', (fileName, mediaType, description) => {
    const markup = renderToStaticMarkup(
      <DownloadOnlyState fileName={fileName} mediaType={mediaType} />,
    );
    expect(markup).toContain('<h');
    expect(markup).toContain('Preview unavailable');
    expect(markup).toContain(description);
    expect(markup).not.toContain(fileName);
    expect(markup).not.toContain(mediaType);
    expect(markup).not.toContain('42');
    expect(markup).not.toContain('<button');
  });

  it.each([
    ['archive.zip', 'application/zip'],
    ['font.ttf', 'font/ttf'],
    ['payload.bin', 'application/octet-stream'],
    ['legacy.doc', 'application/msword'],
    ['unknown.data', 'application/x-custom-binary'],
  ] as const)('renders one toolbar download for %s', (fileName, mediaType) => {
    const markup = renderToStaticMarkup(
      <ArtifactFileView
        capabilities={{ download: () => undefined }}
        content={{ status: 'ready' }}
        file={{ id: `file:${fileName}`, mediaType, name: fileName }}
      />,
    );
    expect(markup).toContain('Preview unavailable');
    expect((markup.match(/aria-label="Download"/gu) ?? []).length).toBe(1);
    expect(markup).not.toContain('download-only-state"><button');
    expect(markup).not.toContain('This file could not be loaded');
  });

  it('uses the same state for an unsupported file selected in a public folder share', () => {
    const entries: FolderEntry[] = [
      {
        kind: 'file',
        path: 'archives/release.zip',
        mediaType: 'application/zip',
        contentHash: `sha256:${'d'.repeat(64)}`,
        byteCount: 42,
      },
    ];
    const markup = renderToStaticMarkup(
      <FolderBrowser
        downloadFile={() => undefined}
        entries={entries}
        loadFile={async () => {
          throw new Error('download-only files must not load preview bytes');
        }}
      />,
    );
    expect(markup).toContain('Preview unavailable');
    expect(markup).toContain('Download the archive to open its contents.');
    expect((markup.match(/aria-label="Download"/gu) ?? []).length).toBe(1);
    expect(markup).not.toContain('This file could not be loaded');
    expect(markup).not.toContain('application/zip');
    expect(markup).not.toContain('42 B');
  });

  it('loads and keeps authenticated HTML in the source view when the renderer is unavailable', () => {
    expect(selectRenderer('text/html', undefined, 'index.html')).toEqual({ kind: 'download' });
    expect(supportsSourceView('text/html', 'index.html')).toBe(true);
    expect(shouldLoadManagedRevisionBytes(managedHtmlRevision)).toBe(true);
    const markup = renderToStaticMarkup(
      <ManagedArtifactContent
        bytes={new TextEncoder().encode('<!doctype html><h1>Shelf</h1>').buffer}
        entries={[]}
        revision={managedHtmlRevision}
      />,
    );
    expect(markup).toContain('Artifact source');
    expect(markup).not.toContain('Download-only format');
  });

  it('uses the same download-only state for managed folder entries', () => {
    const entries: FolderEntry[] = [
      {
        kind: 'file',
        path: 'legacy.xls',
        mediaType: 'application/octet-stream',
        contentHash: `sha256:${'d'.repeat(64)}`,
        byteCount: 42,
      },
    ];
    const markup = renderToStaticMarkup(
      <FolderBrowser
        downloadFile={() => undefined}
        entries={entries}
        loadFile={async () => {
          throw new Error('managed download-only files must not load preview bytes');
        }}
      />,
    );
    expect(markup).toContain('Preview unavailable');
    expect(markup).toContain('Download this file to open it in an Office app.');
    expect((markup.match(/aria-label="Download"/gu) ?? []).length).toBe(1);
    expect(markup).not.toContain('This file could not be loaded');
  });
});
