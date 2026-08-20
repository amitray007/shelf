import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifactShare,
  createDashboardCredential,
  createWorkspace,
  DashboardApiError,
  DashboardAuthenticationError,
  deleteArtifact,
  ensureArtifactDefaultShares,
  loadArtifactCommentSummaries,
  loadArtifacts,
  loadDashboardCredentials,
  loadDashboardSession,
  loadFolderEntries,
  recoverArtifact,
  renameArtifact,
  restoreArtifact,
} from '../src/dashboard/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dashboard API client', () => {
  it('loads comment summaries in one validated workspace request', async () => {
    const artifactId = `art_${'a'.repeat(22)}`;
    const summary = {
      artifactId,
      participantCount: 1,
      participants: [
        {
          participantId: 'visitor_1',
          displayName: 'Ada',
          threadCount: 2,
          replyCount: 3,
          latestThreadId: 'thread_1',
          latestActivityAt: '2026-08-19T00:00:00.000Z',
          recentThreads: [{ threadId: 'thread_1', latestActivityAt: '2026-08-19T00:00:00.000Z' }],
        },
      ],
      openThreadCount: 2,
      openReplyCount: 3,
      latestActivityAt: '2026-08-19T00:00:00.000Z',
      latestThreadId: 'thread_1',
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({ artifactIds: [artifactId] });
      return json({ items: [summary] });
    });
    globalThis.fetch = fetch;

    await expect(loadArtifactCommentSummaries('workspace/main', [artifactId])).resolves.toEqual([
      summary,
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/workspaces/workspace%2Fmain/comments/summaries');
  });

  it('rejects malformed or out-of-request comment summaries', async () => {
    const requestedId = `art_${'a'.repeat(22)}`;
    const response = {
      artifactId: `art_${'b'.repeat(22)}`,
      participantCount: 0,
      participants: [],
      openThreadCount: 0,
      openReplyCount: 0,
      latestActivityAt: null,
      latestThreadId: null,
      recentThreads: [],
    };
    globalThis.fetch = vi.fn(async () => json({ items: [response] }));
    await expect(
      loadArtifactCommentSummaries('workspace-main', [requestedId]),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    globalThis.fetch = vi.fn(async () =>
      json({ items: [{ ...response, artifactId: requestedId, unexpected: true }] }),
    );
    await expect(
      loadArtifactCommentSummaries('workspace-main', [requestedId]),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('loads the human session with same-origin cookies and validates the contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        apiVersion: 'v1',
        actorId: 'act_owner',
        workspaces: [{ workspaceId: 'workspace-main', actions: ['revision.read'] }],
      }),
    );
    globalThis.fetch = fetch;
    await expect(loadDashboardSession()).resolves.toMatchObject({ actorId: 'act_owner' });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/dashboard/session',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
  });

  it('creates a workspace through the owner session API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(
        {
          apiVersion: 'v1',
          workspaceId: 'workspace-work',
          actions: ['file.publish', 'revision.read'],
        },
        201,
      ),
    );
    globalThis.fetch = fetch;
    await expect(createWorkspace('workspace-work')).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-work',
      actions: ['file.publish', 'revision.read'],
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workspaces',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
  });

  it('turns only a 401 into a sign-in redirect signal', async () => {
    globalThis.fetch = vi.fn(async () => json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401));
    await expect(loadDashboardSession()).rejects.toBeInstanceOf(DashboardAuthenticationError);

    globalThis.fetch = vi.fn(async () => json({ apiVersion: 'v1', workspaces: [] }));
    await expect(loadDashboardSession()).rejects.toThrow('invalid response');

    globalThis.fetch = vi.fn(async () => new Response('<h1>Sign in</h1>', { status: 401 }));
    await expect(loadDashboardSession()).rejects.toBeInstanceOf(DashboardAuthenticationError);
  });

  it('bounds a stalled request while preserving caller cancellation', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const stalled = loadDashboardSession();
    const stalledResult = expect(stalled).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000);
    await stalledResult;

    const controller = new AbortController();
    const cancelled = loadDashboardSession(controller.signal);
    controller.abort(new Error('route changed'));
    await expect(cancelled).rejects.toThrow('route changed');
  });

  it('encodes workspace and cursor paths without accepting arbitrary URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ apiVersion: 'v1', items: [], nextCursor: null }),
    );
    globalThis.fetch = fetch;
    await loadArtifacts('workspace/main', 'opaque cursor', undefined, 'updated', 'desc', 'readme');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/v1/workspaces/workspace%2Fmain/artifacts?limit=10&sort=updated&order=desc&cursor=opaque+cursor&search=readme',
    );
  });

  it('loads only credentials granted to the selected workspace', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ apiVersion: 'v1', items: [], nextCursor: null }),
    );
    globalThis.fetch = fetch;
    await loadDashboardCredentials('workspace/main', 'credential cursor');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/v1/access-credentials?limit=50&workspaceId=workspace%2Fmain&cursor=credential+cursor',
    );
  });

  it('uses exact mutation methods and validates one-time credential results', async () => {
    const token = `shf_v1.${'a'.repeat(22)}.${'b'.repeat(43)}`;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          apiVersion: 'v1',
          workspaceId: 'workspace-main',
          artifactId: `art_${'a'.repeat(22)}`,
          kind: 'file',
          name: 'Renamed',
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
          latestRevision: {
            kind: 'file',
            revisionId: `rev_${'b'.repeat(22)}`,
            revisionNumber: 1,
            originalFileName: 'idea.md',
            mediaType: 'text/markdown',
            byteCount: 4,
            fileCount: 1,
            contentHash: `sha256:${'c'.repeat(64)}`,
            createdAt: '2026-08-18T00:00:00.000Z',
            provenance: {
              classification: 'direct-publish',
              observed: { actorId: 'act_owner', operation: 'file.publish' },
            },
            publisherMetadata: {},
            paths: {
              revision: `/api/v1/revisions/rev_${'b'.repeat(22)}`,
              content: `/api/v1/revisions/rev_${'b'.repeat(22)}/content`,
            },
          },
          paths: {
            artifact: `/api/v1/artifacts/art_${'a'.repeat(22)}`,
            revisions: `/api/v1/artifacts/art_${'a'.repeat(22)}/revisions`,
          },
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            apiVersion: 'v1',
            credentialId: `crd_${'d'.repeat(22)}`,
            actorId: 'act_agent',
            actorName: 'agent',
            token,
            expiresAt: null,
            grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
          },
          201,
        ),
      );
    globalThis.fetch = fetch;

    await renameArtifact(`art_${'a'.repeat(22)}`, 'Renamed');
    await expect(
      createDashboardCredential({
        actorName: 'agent',
        grants: [{ workspaceId: 'workspace-main', action: 'revision.read' }],
      }),
    ).resolves.toMatchObject({ token });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('uses caller-owned idempotency keys for retried restore and share mutations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ invalid: true }));
    globalThis.fetch = fetch;
    const key = 'intent-key';
    await expect(
      restoreArtifact('workspace-main', `art_${'a'.repeat(22)}`, `rev_${'b'.repeat(22)}`, key),
    ).rejects.toBeInstanceOf(DashboardApiError);
    await expect(
      createArtifactShare(
        'workspace-main',
        `art_${'a'.repeat(22)}`,
        { accessType: 'protected', target: { mode: 'latest' }, expiresIn: 'never' },
        key,
      ),
    ).rejects.toBeInstanceOf(DashboardApiError);
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ 'idempotency-key': key });
    }
  });

  it('loads both prepared defaults through one artifact-scoped request', async () => {
    const artifactId = `art_${'a'.repeat(22)}`;
    const protectedShare = {
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId,
      shareId: `shr_${'b'.repeat(22)}`,
      visibility: 'unlisted',
      accessType: 'protected',
      target: { mode: 'latest' },
      createdAt: '2026-08-19T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      status: 'active',
      maxSessions: null,
      sessionsUsed: 0,
      sessionsRemaining: null,
      url: `/s/shr_${'b'.repeat(22)}#${'s'.repeat(43)}`,
    } as const;
    const publicShare = {
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId,
      shareId: `shr_${'c'.repeat(22)}`,
      visibility: 'unlisted',
      accessType: 'public',
      target: { mode: 'latest' },
      createdAt: '2026-08-19T00:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      status: 'active',
      publicCode: 'PublicCode12',
      url: '/s/PublicCode12',
    } as const;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        apiVersion: 'v1',
        workspaceId: 'workspace-main',
        artifactId,
        protected: protectedShare,
        public: publicShare,
      }),
    );
    globalThis.fetch = fetch;

    await expect(ensureArtifactDefaultShares('workspace-main', artifactId)).resolves.toMatchObject({
      protected: protectedShare,
      public: publicShare,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].toString()).toContain(
      `/artifacts/${artifactId}/shares/defaults`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
    });
  });

  it('sends canonical Protected and Public share policies without dropping mode fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ invalid: true }));
    globalThis.fetch = fetch;
    await expect(
      createArtifactShare(
        'workspace-main',
        `art_${'a'.repeat(22)}`,
        {
          accessType: 'protected',
          target: { mode: 'latest' },
          expiresIn: '7d',
          maxSessions: 5,
        },
        'protected-key',
      ),
    ).rejects.toBeInstanceOf(DashboardApiError);
    await expect(
      createArtifactShare(
        'workspace-main',
        `art_${'a'.repeat(22)}`,
        {
          accessType: 'public',
          target: { mode: 'pinned', revisionId: `rev_${'b'.repeat(22)}` },
          expiresAt: '2026-08-19T12:00:00.000Z',
        },
        'public-key',
      ),
    ).rejects.toBeInstanceOf(DashboardApiError);

    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({
      accessType: 'protected',
      target: { mode: 'latest' },
      expiresIn: '7d',
      maxSessions: 5,
    });
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      accessType: 'public',
      target: { mode: 'pinned', revisionId: `rev_${'b'.repeat(22)}` },
      expiresAt: '2026-08-19T12:00:00.000Z',
    });
  });

  it('uses the recoverable artifact lifecycle endpoints and validates their results', async () => {
    const artifactId = `art_${'a'.repeat(22)}`;
    const deleted = {
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId,
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
      revokedShareCount: 1,
    };
    const recovered = {
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      artifactId,
      kind: 'file',
      name: 'idea.md',
      createdAt: '2026-08-18T10:00:00.000Z',
      updatedAt: '2026-08-18T10:00:00.000Z',
      latestRevision: {
        kind: 'file',
        revisionId: `rev_${'b'.repeat(22)}`,
        revisionNumber: 1,
        originalFileName: 'idea.md',
        mediaType: 'text/markdown',
        byteCount: 4,
        fileCount: 1,
        contentHash: `sha256:${'c'.repeat(64)}`,
        createdAt: '2026-08-18T10:00:00.000Z',
        provenance: {
          classification: 'direct-publish',
          observed: { actorId: 'act_owner', operation: 'file.publish' },
        },
        publisherMetadata: {},
        paths: {
          revision: `/api/v1/revisions/rev_${'b'.repeat(22)}`,
          content: `/api/v1/revisions/rev_${'b'.repeat(22)}/content`,
        },
      },
      paths: {
        artifact: `/api/v1/artifacts/${artifactId}`,
        revisions: `/api/v1/artifacts/${artifactId}/revisions`,
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(deleted))
      .mockResolvedValueOnce(json(recovered));
    globalThis.fetch = fetch;

    await expect(deleteArtifact(artifactId)).resolves.toEqual(deleted);
    await expect(recoverArtifact(artifactId, 'recovery-key')).resolves.toEqual(recovered);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/artifacts/${artifactId}`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/artifacts/${artifactId}/recovery`);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': 'recovery-key' },
    });
  });

  it('loads bounded folder pages and rejects repeated or mismatched continuations', async () => {
    const revisionId = `rev_${'a'.repeat(22)}`;
    const page = (nextCursor: string | null, revision = revisionId) => ({
      apiVersion: 'v1',
      revisionId: revision,
      contentHash: `sha256:${'b'.repeat(64)}`,
      byteCount: 0,
      fileCount: 0,
      items: [],
      nextCursor,
    });
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(page('next')))
      .mockResolvedValueOnce(json(page(null)));
    await expect(loadFolderEntries(revisionId)).resolves.toEqual([]);

    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(page('repeat')))
      .mockResolvedValueOnce(json(page('repeat')));
    await expect(loadFolderEntries(revisionId)).rejects.toThrow('invalid response');

    globalThis.fetch = vi.fn(async () => json(page(null, `rev_${'c'.repeat(22)}`)));
    await expect(loadFolderEntries(revisionId)).rejects.toThrow('invalid response');

    let pageNumber = 0;
    globalThis.fetch = vi.fn(async () => {
      pageNumber += 1;
      return json({
        ...page(pageNumber === 21 ? null : `page-${pageNumber}`),
        items: Array.from({ length: 100 }, (_, index) => ({
          path: `directory-${pageNumber}-${index}`,
          kind: 'directory',
        })),
      });
    });
    await expect(loadFolderEntries(revisionId)).rejects.toThrow('invalid response');
  });
});
