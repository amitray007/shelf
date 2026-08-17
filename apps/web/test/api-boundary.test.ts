import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPublicFolderEntries, PublicShareUnavailableError } from '../src/api.js';
import type { FolderShareResolution } from '../src/share-types.js';
import { loadViewerPayload } from '../src/viewer-page.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const SECRET = 'S'.repeat(43);
const REVISION_ID = `rev_${'c'.repeat(22)}`;

function folderResolution(): FolderShareResolution {
  return {
    apiVersion: 'v1',
    shareId: SHARE_ID,
    target: { mode: 'latest' },
    expiresAt: null,
    artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'folder', name: 'idea' },
    revision: {
      revisionId: REVISION_ID,
      revisionNumber: 1,
      createdAt: '2026-08-18T12:00:00.000Z',
      kind: 'folder',
      rootName: 'idea',
      byteCount: 12,
      fileCount: 2,
    },
    action: { type: 'tree', path: `/api/v1/public/shares/${SHARE_ID}/tree` },
  };
}

function folderPage(items: readonly Record<string, unknown>[], nextCursor: string | null) {
  return {
    apiVersion: 'v1',
    revisionId: REVISION_ID,
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteCount: 12,
    fileCount: 2,
    items,
    nextCursor,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewer content boundary', () => {
  it('resolves active HTML without downloading its bytes into the app origin', async () => {
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      target: { mode: 'latest' },
      expiresAt: null,
      artifact: {
        artifactId: `art_${'b'.repeat(22)}`,
        kind: 'file',
        name: 'interactive.html',
      },
      revision: {
        revisionId: `rev_${'c'.repeat(22)}`,
        revisionNumber: 1,
        createdAt: '2026-08-18T12:00:00.000Z',
        kind: 'file',
        originalFileName: 'interactive.html',
        mediaType: 'text/html',
        byteCount: 128,
      },
      action: {
        type: 'content',
        path: `/api/v1/public/shares/${SHARE_ID}/content`,
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(resolution));
    vi.stubGlobal('fetch', fetch);

    const payload = await loadViewerPayload(
      SHARE_ID,
      SECRET,
      undefined,
      'https://renderer.shelf.example/',
    );

    expect(payload).toMatchObject({ kind: 'file', bytes: null });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/public/shares/${SHARE_ID}/resolve`);
  });

  it('does not buffer download-only bytes before the user requests them', async () => {
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      target: { mode: 'latest' },
      expiresAt: null,
      artifact: {
        artifactId: `art_${'b'.repeat(22)}`,
        kind: 'file',
        name: 'document.pdf',
      },
      revision: {
        revisionId: `rev_${'c'.repeat(22)}`,
        revisionNumber: 1,
        createdAt: '2026-08-18T12:00:00.000Z',
        kind: 'file',
        originalFileName: 'document.pdf',
        mediaType: 'application/pdf',
        byteCount: 10_000_000,
      },
      action: {
        type: 'content',
        path: `/api/v1/public/shares/${SHARE_ID}/content`,
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(resolution));
    vi.stubGlobal('fetch', fetch);

    await expect(loadViewerPayload(SHARE_ID, SECRET, undefined, undefined)).resolves.toMatchObject({
      kind: 'file',
      bytes: null,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pages a public folder with the exact bounded cursor contract', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(folderPage([{ path: 'docs', kind: 'directory' }], 'next-page')),
      )
      .mockResolvedValueOnce(
        Response.json(
          folderPage(
            [
              {
                path: 'docs/idea.md',
                kind: 'file',
                mediaType: 'text/markdown',
                contentHash: `sha256:${'b'.repeat(64)}`,
                byteCount: 12,
              },
            ],
            null,
          ),
        ),
      );
    vi.stubGlobal('fetch', fetch);

    await expect(loadPublicFolderEntries(folderResolution(), SECRET)).resolves.toEqual([
      { path: 'docs', kind: 'directory' },
      expect.objectContaining({ path: 'docs/idea.md', kind: 'file' }),
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/public/shares/${SHARE_ID}/tree`);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `/api/v1/public/shares/${SHARE_ID}/tree?limit=100&cursor=next-page`,
    );
  });

  it.each([
    ['a repeated cursor', [folderPage([], 'again'), folderPage([], 'again')]],
    ['a revision mismatch', [{ ...folderPage([], null), revisionId: `rev_${'z'.repeat(22)}` }]],
  ])('rejects %s from the public folder boundary', async (_label, pages) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const page of pages) fetch.mockResolvedValueOnce(Response.json(page));
    vi.stubGlobal('fetch', fetch);

    await expect(loadPublicFolderEntries(folderResolution(), SECRET)).rejects.toBeInstanceOf(
      PublicShareUnavailableError,
    );
  });
});
