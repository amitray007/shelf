import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createViewerCommentReply,
  createViewerCommentThread,
  establishProtectedSession,
  loadViewerComments,
  loadViewerFolderEntries,
  PublicShareUnavailableError,
  resolveViewerShare,
  updateViewerCommentPost,
  updateViewerCommentThread,
  ViewerCommentRevisionMismatchError,
} from '../src/api.js';
import {
  capabilityStorageKey,
  protectedSessionIdStorageKey,
  protectedViewerTokenStorageKey,
} from '../src/capability.js';
import type { FolderShareResolution } from '../src/share-types.js';
import { loadViewerPayload, updateViewerThreadUrl, viewerLoader } from '../src/viewer-page.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const SECRET = 'S'.repeat(43);
const REVISION_ID = `rev_${'c'.repeat(22)}`;
const PUBLIC_CODE = 'AbCdEf0123_-';
const TOKEN = `${'v'.repeat(24)}.${'s'.repeat(43)}`;
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function folderResolution(): FolderShareResolution {
  return {
    apiVersion: 'v1',
    shareId: SHARE_ID,
    accessType: 'protected',
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
  it('projects a Latest revision race as an actionable review error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 'INVALID_REQUEST',
              message: 'The comment request is invalid.',
              retryable: false,
              details: [
                {
                  field: 'revisionId',
                  reason: 'must match the revision rendered by the shared link',
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const error = await createViewerCommentThread({
      resolution: folderResolution(),
      authority: {
        accessType: 'protected',
        shareId: SHARE_ID,
        sessionId: SESSION_ID,
        token: TOKEN,
      },
      visitorToken: 'V'.repeat(43),
      displayName: 'A reviewer',
      anchor: { revisionId: REVISION_ID, kind: 'file' },
      body: 'Keep this draft.',
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ViewerCommentRevisionMismatchError);
    expect((error as Error).message).toContain('draft is still here');
    expect((error as Error).message).toContain('re-anchor');
  });

  it('updates the thread query while preserving the protected capability hash', () => {
    expect(updateViewerThreadUrl(`/s/${SHARE_ID}?mode=source#${SECRET}`, 'thread_1')).toBe(
      `/s/${SHARE_ID}?mode=source&thread=thread_1#${SECRET}`,
    );
    expect(updateViewerThreadUrl(`/s/${SHARE_ID}?mode=source&thread=thread_1#${SECRET}`, '')).toBe(
      `/s/${SHARE_ID}?mode=source#${SECRET}`,
    );
  });

  it('keeps visitor credentials in anonymous comment request bodies', async () => {
    const visitorToken = 'V'.repeat(43);
    const thread = {
      threadId: 'thread_1',
      workspaceId: 'workspace_1',
      artifactId: `art_${'b'.repeat(22)}`,
      shareId: SHARE_ID,
      revisionId: REVISION_ID,
      visibility: 'shared',
      anchor: { revisionId: REVISION_ID, kind: 'file' },
      anchorStatus: 'exact',
      resolvedAt: null,
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:00.000Z',
      permissions: { canReply: true, canResolve: true, canReopen: false },
      posts: [
        {
          postId: 'post_1',
          threadId: 'thread_1',
          body: 'Keep this line.',
          author: { kind: 'visitor', participantId: 'visitor_1', displayName: 'A reviewer' },
          permissions: { canEdit: true, canDelete: true, canModerate: false },
          createdAt: '2026-08-18T12:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
      ],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ items: [thread], nextCursor: null }))
      .mockResolvedValueOnce(Response.json(thread, { status: 201 }))
      .mockResolvedValueOnce(Response.json(thread.posts[0], { status: 201 }))
      .mockResolvedValueOnce(Response.json(thread))
      .mockResolvedValueOnce(Response.json(thread.posts[0]))
      .mockResolvedValueOnce(Response.json(thread.posts[0]));
    vi.stubGlobal('fetch', fetch);
    const resolution = folderResolution();
    const authority = {
      accessType: 'protected' as const,
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      token: TOKEN,
    };
    const context = { resolution, authority, visitorToken, displayName: 'A reviewer' };

    await expect(loadViewerComments(context)).resolves.toMatchObject({
      items: [thread],
      nextCursor: null,
    });
    await createViewerCommentThread({
      ...context,
      anchor: { revisionId: REVISION_ID, kind: 'file' },
      body: 'Keep this line.',
    });
    await createViewerCommentReply({ ...context, threadId: 'thread_1', body: 'Agreed.' });
    await updateViewerCommentThread({ ...context, threadId: 'thread_1', status: 'resolve' });
    await updateViewerCommentPost({
      ...context,
      postId: 'post_1',
      action: 'edit',
      body: 'Edited.',
    });
    await updateViewerCommentPost({ ...context, postId: 'post_1', action: 'delete' });

    expect(fetch.mock.calls.map(([input]) => input)).toEqual([
      `/api/v1/public/shares/${SHARE_ID}/comments/query`,
      `/api/v1/public/shares/${SHARE_ID}/comments/threads`,
      `/api/v1/public/shares/${SHARE_ID}/comments/threads/thread_1/replies`,
      `/api/v1/public/shares/${SHARE_ID}/comments/threads/thread_1`,
      `/api/v1/public/shares/${SHARE_ID}/comments/posts/post_1`,
      `/api/v1/public/shares/${SHARE_ID}/comments/posts/post_1`,
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'PATCH',
      'PATCH',
      'PATCH',
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(String(init?.body)).toContain(visitorToken);
      expect(String(init?.body)).toContain(TOKEN);
      expect(String(init?.body)).not.toContain('http');
    }
    expect(JSON.parse(String(fetch.mock.calls[4]?.[1]?.body))).toMatchObject({
      action: 'edit',
      body: 'Edited.',
    });
    expect(JSON.parse(String(fetch.mock.calls[5]?.[1]?.body))).toMatchObject({ action: 'delete' });
  });

  it('rejects malformed comment post responses instead of trusting partial shapes', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(Response.json({ postId: 'post_1' }, { status: 201 }))
        .mockResolvedValueOnce(
          Response.json({ postId: 'post_1', threadId: 'thread_1', permissions: {} }),
        ),
    );
    const context = {
      resolution: {
        ...folderResolution(),
        accessType: 'public' as const,
        publicCode: PUBLIC_CODE,
        action: { type: 'tree' as const, path: `/api/v1/public/links/${PUBLIC_CODE}/tree` },
      },
      authority: {
        accessType: 'public' as const,
        publicCode: PUBLIC_CODE,
      },
      visitorToken: 'V'.repeat(43),
      displayName: 'A reviewer',
    };

    await expect(
      createViewerCommentReply({ ...context, threadId: 'thread_1', body: 'Reply' }),
    ).rejects.toBeInstanceOf(PublicShareUnavailableError);
    await expect(
      updateViewerCommentPost({ ...context, postId: 'post_1', action: 'delete' }),
    ).rejects.toBeInstanceOf(PublicShareUnavailableError);
  });

  it('loads active HTML source while keeping execution in the isolated renderer', async () => {
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      accessType: 'protected',
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
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(resolution))
      .mockResolvedValueOnce(new Response('<h1>Shared source</h1>'));
    vi.stubGlobal('fetch', fetch);

    const payload = await loadViewerPayload(
      { accessType: 'protected', shareId: SHARE_ID },
      { accessType: 'protected', shareId: SHARE_ID, sessionId: SESSION_ID, token: TOKEN },
      undefined,
      'https://renderer.shelf.example/',
    );

    expect(payload).toMatchObject({ kind: 'file' });
    if (payload.kind !== 'file' || payload.bytes === null) throw new Error('Expected file bytes.');
    expect(new TextDecoder().decode(payload.bytes)).toBe('<h1>Shared source</h1>');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/public/shares/${SHARE_ID}/resolve`);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/public/shares/${SHARE_ID}/content`);
  });

  it('does not buffer download-only bytes before the user requests them', async () => {
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      accessType: 'protected',
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

    await expect(
      loadViewerPayload(
        { accessType: 'protected', shareId: SHARE_ID },
        { accessType: 'protected', shareId: SHARE_ID, sessionId: SESSION_ID, token: TOKEN },
        undefined,
        undefined,
      ),
    ).resolves.toMatchObject({ kind: 'file', bytes: null });
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

    await expect(
      loadViewerFolderEntries(folderResolution(), {
        accessType: 'protected',
        shareId: SHARE_ID,
        sessionId: SESSION_ID,
        token: TOKEN,
      }),
    ).resolves.toEqual([
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

    await expect(
      loadViewerFolderEntries(folderResolution(), {
        accessType: 'protected',
        shareId: SHARE_ID,
        sessionId: SESSION_ID,
        token: TOKEN,
      }),
    ).rejects.toBeInstanceOf(PublicShareUnavailableError);
  });

  it('establishes Protected authority once with a capability and renews with only its token', async () => {
    const authority = {
      apiVersion: 'v1' as const,
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      token: TOKEN,
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-20T00:00:00.000Z',
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(authority));
    vi.stubGlobal('fetch', fetch);

    await establishProtectedSession(SHARE_ID, SESSION_ID, { secret: SECRET });
    await establishProtectedSession(SHARE_ID, SESSION_ID, { token: TOKEN });

    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { sessionId: SESSION_ID, secret: SECRET },
      { sessionId: SESSION_ID, token: TOKEN },
    ]);
    for (const call of fetch.mock.calls) {
      expect(call[0]).toBe(`/api/v1/public/shares/${SHARE_ID}/sessions`);
      expect(call[1]).toMatchObject({
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      expect(String(call[0])).not.toContain(SECRET);
      expect(String(call[0])).not.toContain(TOKEN);
    }
  });

  it('uses discriminated Protected POST and Public secret-free GET authority', async () => {
    const protectedResolution = { ...folderResolution(), accessType: 'protected' as const };
    const publicResolution = {
      ...folderResolution(),
      accessType: 'public' as const,
      publicCode: PUBLIC_CODE,
      expiresAt: '2026-08-20T00:00:00.000Z',
      action: { type: 'tree' as const, path: `/api/v1/public/links/${PUBLIC_CODE}/tree` },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(protectedResolution))
      .mockResolvedValueOnce(Response.json(publicResolution));
    vi.stubGlobal('fetch', fetch);

    await resolveViewerShare(
      { accessType: 'protected', shareId: SHARE_ID },
      { accessType: 'protected', shareId: SHARE_ID, sessionId: SESSION_ID, token: TOKEN },
    );
    await resolveViewerShare(
      { accessType: 'public', publicCode: PUBLIC_CODE },
      { accessType: 'public', publicCode: PUBLIC_CODE },
    );

    expect(fetch.mock.calls[0]).toEqual([
      `/api/v1/public/shares/${SHARE_ID}/resolve`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: TOKEN }) }),
    ]);
    expect(fetch.mock.calls[1]).toEqual([
      `/api/v1/public/links/${PUBLIC_CODE}/resolve`,
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    ]);
  });

  it('scrubs and establishes an old fragment link, then replaces capability storage with token authority', async () => {
    const storage = memoryStorage();
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { hash: `#${SECRET}`, pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: null, replaceState },
      sessionStorage: storage,
    });
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      accessType: 'protected',
      target: { mode: 'latest' },
      expiresAt: null,
      artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'page.html' },
      revision: {
        revisionId: REVISION_ID,
        revisionNumber: 1,
        createdAt: '2026-08-19T00:00:00.000Z',
        kind: 'file',
        originalFileName: 'page.html',
        mediaType: 'text/html',
        byteCount: 10,
      },
      action: { type: 'content', path: `/api/v1/public/shares/${SHARE_ID}/content` },
    };
    const established = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      token: TOKEN,
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-20T00:00:00.000Z',
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(established))
      .mockResolvedValueOnce(Response.json({ apiVersion: 'v1', rendererOrigin: null }))
      .mockResolvedValueOnce(Response.json(resolution))
      .mockResolvedValueOnce(new Response('<p>Source</p>'));
    vi.stubGlobal('fetch', fetch);

    await viewerLoader({
      params: { shareRef: SHARE_ID },
      request: new Request(`https://shelf.test/s/${SHARE_ID}`),
    } as never);

    expect(replaceState).toHaveBeenCalledWith(null, '', `/s/${SHARE_ID}`);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: SESSION_ID,
      secret: SECRET,
    });
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBeNull();
    expect(storage.getItem(protectedViewerTokenStorageKey(SHARE_ID))).toBe(TOKEN);
  });

  it('renews the same stored session on refresh without replaying the capability', async () => {
    const storage = memoryStorage();
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    storage.setItem(protectedViewerTokenStorageKey(SHARE_ID), TOKEN);
    vi.stubGlobal('window', {
      location: { hash: '', pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: storage,
    });
    const renewed = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      token: `${TOKEN}r`,
      issuedAt: '2026-08-20T00:00:00.000Z',
      expiresAt: '2026-08-21T00:00:00.000Z',
    };
    const resolution = {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      accessType: 'protected',
      target: { mode: 'latest' },
      expiresAt: null,
      artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'page.html' },
      revision: {
        revisionId: REVISION_ID,
        revisionNumber: 1,
        createdAt: '2026-08-19T00:00:00.000Z',
        kind: 'file',
        originalFileName: 'page.html',
        mediaType: 'text/html',
        byteCount: 10,
      },
      action: { type: 'content', path: `/api/v1/public/shares/${SHARE_ID}/content` },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(renewed))
      .mockResolvedValueOnce(Response.json({ apiVersion: 'v1', rendererOrigin: null }))
      .mockResolvedValueOnce(Response.json(resolution))
      .mockResolvedValueOnce(new Response('<p>Source</p>'));
    vi.stubGlobal('fetch', fetch);

    await viewerLoader({
      params: { shareRef: SHARE_ID },
      request: new Request(`https://shelf.test/s/${SHARE_ID}`),
    } as never);

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      sessionId: SESSION_ID,
      token: TOKEN,
    });
    expect(storage.getItem(protectedViewerTokenStorageKey(SHARE_ID))).toBe(`${TOKEN}r`);
  });

  it('retains a captured capability when initial establishment fails at the network boundary', async () => {
    const storage = memoryStorage();
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    vi.stubGlobal('window', {
      location: { hash: `#${SECRET}`, pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: storage,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error('offline'))),
    );

    await expect(
      viewerLoader({
        params: { shareRef: SHARE_ID },
        request: new Request(`https://shelf.test/s/${SHARE_ID}`),
      } as never),
    ).rejects.toMatchObject({ failure: 'transient' });
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBe(SECRET);
  });

  it.each([
    ['a 503 response', () => new Response('', { status: 503 })],
    [
      'an unreadable success body',
      () => {
        const response = Response.json({});
        vi.spyOn(response, 'json').mockRejectedValue(new Error('body interrupted'));
        return response;
      },
    ],
  ])('retains a captured capability after %s', async (_label, response) => {
    const storage = memoryStorage();
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    vi.stubGlobal('window', {
      location: { hash: `#${SECRET}`, pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: storage,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () => response()),
    );

    await expect(
      viewerLoader({
        params: { shareRef: SHARE_ID },
        request: new Request(`https://shelf.test/s/${SHARE_ID}`),
      } as never),
    ).rejects.toMatchObject({ failure: 'transient' });
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBe(SECRET);
  });

  it('removes a captured capability after a definitive establishment rejection', async () => {
    const storage = memoryStorage();
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    vi.stubGlobal('window', {
      location: { hash: `#${SECRET}`, pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: storage,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 404 })),
    );

    await expect(
      viewerLoader({
        params: { shareRef: SHARE_ID },
        request: new Request(`https://shelf.test/s/${SHARE_ID}`),
      } as never),
    ).rejects.toMatchObject({ failure: 'terminal' });
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBeNull();
  });
});
