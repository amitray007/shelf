import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  thread: 'thread_01',
  post: 'post_01',
};

const thread = {
  threadId: ids.thread,
  workspaceId: 'workspace-main',
  artifactId: ids.artifact,
  shareId: 'shr_CCCCCCCCCCCCCCCCCCCCCC',
  revisionId: ids.revision,
  visibility: 'private',
  anchor: { revisionId: ids.revision, kind: 'file' },
  anchorStatus: 'exact',
  resolvedAt: null,
  createdAt: '2026-08-18T12:00:00.000Z',
  updatedAt: '2026-08-18T12:00:00.000Z',
  permissions: { canReply: true, canResolve: true, canReopen: false },
  posts: [
    {
      postId: ids.post,
      threadId: ids.thread,
      body: 'Please review this.',
      author: { kind: 'visitor', participantId: 'visitor_opaque', displayName: 'Reviewer' },
      permissions: { canEdit: false, canDelete: false, canModerate: true },
      createdAt: '2026-08-18T12:00:00.000Z',
      editedAt: null,
      deletedAt: null,
      hiddenAt: null,
    },
  ],
};

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

function runtime(fetch: typeof globalThis.fetch) {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    value: {
      env: { SHELF_TOKEN: 'secret-token' },
      stdout: stdout.write,
      stderr: stderr.write,
      fetch,
    },
  };
}

describe('shelf comments', () => {
  it('documents authenticated review commands and pagination status', async () => {
    const output = runtime(vi.fn() as typeof globalThis.fetch);
    const exitCode = await runCli(['node', 'shelf', 'comments', '--help'], output.value);
    expect(exitCode).toBe(0);
    expect(output.stdout.value()).toContain('list');
    expect(output.stdout.value()).toContain('reply');
    expect(output.stdout.value()).toContain('hide');
  });

  it('lists threads for the latest revision by default and supports an explicit revision', async () => {
    const page = { items: [thread], nextCursor: null };
    const fetch = vi.fn(async () => Response.json(page));
    const output = runtime(fetch);
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'comments',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--revision',
        ids.revision,
      ],
      output.value,
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.value())).toEqual(page);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/workspace-main/artifacts/${ids.artifact}/comments?currentRevisionId=${ids.revision}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
    });
  });

  it('passes comment pagination options through to the API', async () => {
    const fetch = vi.fn(async () => Response.json({ items: [thread], nextCursor: 'older' }));
    const output = runtime(fetch);
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'comments',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--cursor',
        'cursor-token',
        '--limit',
        '10',
      ],
      output.value,
    );
    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('cursor=cursor-token');
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('limit=10');
    expect(JSON.parse(output.stdout.value()).nextCursor).toBe('older');
  });

  it.each([
    ['reply', 'POST', `/comments/threads/${ids.thread}/replies`, { body: 'Done.' }],
    ['resolve', 'PATCH', `/comments/threads/${ids.thread}`, { status: 'resolve' }],
    ['reopen', 'PATCH', `/comments/threads/${ids.thread}`, { status: 'reopen' }],
    ['hide', 'PATCH', `/comments/posts/${ids.post}`, { moderation: 'hide' }],
    ['unhide', 'PATCH', `/comments/posts/${ids.post}`, { moderation: 'unhide' }],
  ] as const)(
    'runs %s through the authenticated moderator route',
    async (command, method, suffix, body) => {
      const fetch = vi.fn(async () =>
        Response.json(
          command === 'reply' || command === 'hide' || command === 'unhide'
            ? thread.posts[0]
            : thread,
          {
            status: command === 'reply' ? 201 : 200,
          },
        ),
      );
      const output = runtime(fetch);
      const args = [
        'node',
        'shelf',
        'comments',
        command,
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        ...(command === 'hide' || command === 'unhide'
          ? ['--post', ids.post]
          : ['--thread', ids.thread]),
        ...(command === 'reply' ? ['--body', 'Done.'] : []),
      ];
      const exitCode = await runCli(args, output.value);
      expect(exitCode).toBe(0);
      expect(JSON.parse(output.stdout.value())).toEqual(
        command === 'reply' || command === 'hide' || command === 'unhide'
          ? thread.posts[0]
          : thread,
      );
      expect(fetch.mock.calls[0]?.[0].toString()).toBe(
        `https://shelf.example/api/v1/workspaces/workspace-main/artifacts/${ids.artifact}${suffix}`,
      );
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        method,
        body: JSON.stringify(body),
        headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
      });
    },
  );

  it('rejects a malformed comment identifier before contacting the API', async () => {
    const fetch = vi.fn();
    const output = runtime(fetch);
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'comments',
        'resolve',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--thread',
        'bad\nthread',
      ],
      output.value,
    );
    expect(exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(output.stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});
