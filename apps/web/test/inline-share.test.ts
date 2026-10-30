import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  clearViewerCaches,
  establishProtectedSession,
  loadViewerFileBytes,
  loadViewerFolderPage,
} from '../src/api.js';
import { FolderBrowser } from '../src/components/folder-browser.js';
import { prepareShareOpen } from '../src/share-boot.js';

const resolution = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  accessType: 'public',
  publicCode: 'AbCdEf0123_-',
  target: { mode: 'latest' },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'file' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 1,
    createdAt: '2026-08-18T12:00:00.000Z',
    kind: 'file',
    mediaType: 'text/plain',
    originalFileName: 'file.txt',
    byteCount: 100,
  },
  action: { type: 'content', path: '/api/v1/public/links/AbCdEf0123_-/content' },
} as const;

afterEach(() => {
  clearViewerCaches();
  vi.unstubAllGlobals();
});
it.each(['file', 'folder'] as const)(
  'seeds %s content from resolution without another request',
  async (kind) => {
    const page = {
      apiVersion: 'v1',
      revisionId: resolution.revision.revisionId,
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 0,
      fileCount: 0,
      items: [],
      nextCursor: null,
    };
    const value =
      kind === 'file'
        ? { ...resolution, inlineContent: { kind: 'file', base64: btoa('hello') } }
        : {
            ...resolution,
            artifact: { ...resolution.artifact, kind: 'folder' },
            revision: {
              revisionId: resolution.revision.revisionId,
              revisionNumber: 1,
              createdAt: resolution.revision.createdAt,
              kind: 'folder',
              rootName: 'docs',
              byteCount: 0,
              fileCount: 0,
            },
            action: { type: 'tree', path: '/api/v1/public/links/AbCdEf0123_-/tree' },
            inlineContent: { kind: 'folder', page },
          };
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/config')) return Response.json({ apiVersion: 'v1' });
      if (url.includes('/resolve')) return Response.json(value);
      throw new Error(`Unexpected second content request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const opened = await prepareShareOpen(
      { accessType: 'public', publicCode: 'AbCdEf0123_-' },
      new AbortController().signal,
    );
    if (kind === 'file')
      expect(
        new TextDecoder().decode(
          await loadViewerFileBytes(opened.resolution as never, opened.authority),
        ),
      ).toBe('hello');
    else
      expect(await loadViewerFolderPage(opened.resolution as never, opened.authority)).toEqual(
        page,
      );
    expect(fetch.mock.calls.filter(([url]) => !url.includes('/config'))).toHaveLength(1);
  },
);

it('renders the same folder entries from the seeded first page without a tree request', async () => {
  const page = {
    apiVersion: 'v1',
    revisionId: resolution.revision.revisionId,
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteCount: 5,
    fileCount: 1,
    items: [
      {
        kind: 'file',
        path: 'notes.txt',
        mediaType: 'text/plain',
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteCount: 5,
      },
    ],
    nextCursor: null,
  };
  const folder = {
    ...resolution,
    artifact: { ...resolution.artifact, kind: 'folder' },
    revision: {
      revisionId: resolution.revision.revisionId,
      revisionNumber: 1,
      createdAt: resolution.revision.createdAt,
      kind: 'folder',
      rootName: 'docs',
      byteCount: 5,
      fileCount: 1,
    },
    action: { type: 'tree', path: '/api/v1/public/links/AbCdEf0123_-/tree' },
  };
  const reference = { accessType: 'public' as const, publicCode: resolution.publicCode };
  const authority = reference;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/config')) return Response.json({ apiVersion: 'v1' });
    if (url.includes('/resolve')) {
      expect(new URL(url, 'https://shelf.test').searchParams.has('inline')).toBe(false);
      expect(new Headers(init?.headers).get('X-Shelf-Inline-Content')).toBe('true');
      return Response.json({ ...folder, inlineContent: { kind: 'folder', page } });
    }
    expect(url).toBe(
      `/api/v1/public/links/AbCdEf0123_-/tree?revisionId=${resolution.revision.revisionId}`,
    );
    return Response.json(page);
  });
  vi.stubGlobal('fetch', fetch);
  // Cold request omits both limit and cursor. The API default is FOLDER_LIMITS.treePageSize.
  const cold = await loadViewerFolderPage(folder as never, authority);
  const render = (entries: typeof cold.items) =>
    renderToStaticMarkup(
      createElement(FolderBrowser, { entries, loadFile: async () => new ArrayBuffer(0) }),
    );
  const expected = render(cold.items);
  clearViewerCaches();
  fetch.mockClear();
  const opened = await prepareShareOpen(reference, new AbortController().signal);
  const seeded = await loadViewerFolderPage(opened.resolution as never, opened.authority);
  expect(seeded).toEqual(cold);
  expect(render(seeded.items)).toBe(expected);
  expect(expected).toContain('notes');
  expect(fetch.mock.calls.some(([url]) => url.includes('/tree'))).toBe(false);
});

it('adds the Protected opt-in header while preserving the JSON body and Content-Type', async () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const secret = 'S'.repeat(43);
  const token = `${'v'.repeat(24)}.${'s'.repeat(43)}`;
  const authority = {
    apiVersion: 'v1',
    shareId: resolution.shareId,
    sessionId,
    token,
    issuedAt: '2026-08-19T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`/api/v1/public/shares/${resolution.shareId}/sessions`);
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Shelf-Inline-Content')).toBe('true');
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId, secret });
    return Response.json(authority);
  });
  vi.stubGlobal('fetch', fetch);
  expect(await establishProtectedSession(resolution.shareId, sessionId, { secret })).toEqual(
    authority,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
