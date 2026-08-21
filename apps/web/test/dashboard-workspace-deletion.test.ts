import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardApiError, deleteWorkspace } from '../src/dashboard/api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dashboard workspace deletion client', () => {
  it('deletes a workspace over a same-origin DELETE and validates the confirmation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      if (
        new Headers(init?.headers).get('content-type') === 'application/json' &&
        init?.body === undefined
      ) {
        return json(
          {
            error: {
              code: 'INVALID_REQUEST',
              message: 'The request is invalid.',
              retryable: false,
              requestId: 'req-empty-json',
            },
          },
          400,
        );
      }
      return json({
        apiVersion: 'v1',
        workspaceId: 'workspace-work',
        deleted: true,
        alreadyDeleted: false,
      });
    });
    globalThis.fetch = fetch;

    await expect(deleteWorkspace('workspace-work')).resolves.toEqual({
      apiVersion: 'v1',
      workspaceId: 'workspace-work',
      deleted: true,
      alreadyDeleted: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/workspaces/workspace-work',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    );
  });

  it('reports an already-deleted workspace as a success', async () => {
    globalThis.fetch = vi.fn(async () =>
      json({
        apiVersion: 'v1',
        workspaceId: 'workspace-work',
        deleted: true,
        alreadyDeleted: true,
      }),
    );

    await expect(deleteWorkspace('workspace-work')).resolves.toMatchObject({
      alreadyDeleted: true,
    });
  });

  it('escapes the workspace ID it puts in the path', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({
        apiVersion: 'v1',
        workspaceId: 'workspace.work',
        deleted: true,
        alreadyDeleted: false,
      }),
    );
    globalThis.fetch = fetch;

    await deleteWorkspace('workspace.work');
    expect(fetch).toHaveBeenCalledWith('/api/v1/workspaces/workspace.work', expect.anything());
  });

  it('surfaces the not-empty refusal message the dialog shows inline', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(
        {
          error: {
            code: 'WORKSPACE_NOT_EMPTY',
            message: 'This workspace still holds artifacts. Delete them first.',
            retryable: false,
            requestId: 'req-1',
          },
        },
        409,
      ),
    );

    await expect(deleteWorkspace('workspace-work')).rejects.toMatchObject({
      name: 'DashboardApiError',
      code: 'WORKSPACE_NOT_EMPTY',
      message: 'This workspace still holds artifacts. Delete them first.',
    });
  });

  it('rejects a response that does not match the delete contract', async () => {
    globalThis.fetch = vi.fn(async () => json({ apiVersion: 'v1', deleted: true }));

    await expect(deleteWorkspace('workspace-work')).rejects.toBeInstanceOf(DashboardApiError);
    await expect(deleteWorkspace('workspace-work')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
