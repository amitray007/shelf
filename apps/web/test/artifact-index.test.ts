import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { artifactFileType } from '../src/dashboard/artifact-file-type.js';

describe('artifact index presentation', () => {
  it('classifies familiar artifact extensions without trusting letter case', () => {
    expect(artifactFileType('idea.md')).toBe('markdown');
    expect(artifactFileType('preview.HTML')).toBe('html');
    expect(artifactFileType('model.json')).toBe('json');
    expect(artifactFileType('archive.tar.gz')).toBe('archive');
    expect(artifactFileType('diagram.svg')).toBe('image');
    expect(artifactFileType('README')).toBe('generic');
  });

  it('keeps the ledger focused on useful dates and direct actions', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/dashboard/artifacts-page.tsx'),
      'utf8',
    );

    expect(source).toContain('Created on');
    expect(source).toContain('Last Updated');
    expect(source).not.toContain('>Revision<');
    expect(source).not.toContain('artifact-revision-column');
    expect(source).not.toContain('artifact-revision-cell');
    expect(source).not.toContain('>Size<');
    expect(source).toContain('Share artifact');
    expect(source).toContain('Preview artifact');
    expect(source).toContain('Delete artifact');
    expect(source).toContain('<ArtifactShareDialog');
    expect(source).toContain(
      '<Table.Head className="artifact-comments-cell">Comments</Table.Head>',
    );
    expect(source).toContain('loadArtifactCommentSummaries');
    expect(source).toContain('discussion=1&thread=');
    expect(source).toContain('Open all comments');
  });

  it('guards reusable share modal results against stale requests', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/dashboard/artifact-share-dialog.tsx'),
      'utf8',
    );

    expect(source).toContain('setShares(undefined)');
    expect(source).toContain('if (!controller.signal.aborted) setShares(defaults)');
  });

  it('keeps file tree focus visible without using the accent selection color', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

    expect(source).toContain('--trees-focus-ring-color-override: var(--focus-ring);');
    expect(source).toContain('--trees-selected-focused-border-color-override: var(--focus-ring);');
  });

  it('collapses hidden dates and keeps mobile controls within the table', async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, '../src/dashboard/artifact-index.css'),
      'utf8',
    );

    expect(source).toContain('width: 128px;');
    expect(source).toContain('width: 0;');
    expect(source).toContain('width: 144px;');
    expect(source).toContain('width: 142px;');
    expect(source).toContain('min-width: 0;');
    expect(source).toContain('"comments actions"');
  });
});
