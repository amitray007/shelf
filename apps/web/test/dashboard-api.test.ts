import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifactShare,
  createDashboardCredential,
  DashboardApiError,
  DashboardAuthenticationError,
  loadArtifacts,
  loadDashboardSession,
  loadFolderEntries,
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
    await loadArtifacts('workspace/main', 'opaque cursor');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/v1/workspaces/workspace%2Fmain/artifacts?limit=50&cursor=opaque+cursor',
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
      createArtifactShare('workspace-main', `art_${'a'.repeat(22)}`, { mode: 'latest' }, null, key),
    ).rejects.toBeInstanceOf(DashboardApiError);
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ 'idempotency-key': key });
    }
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
