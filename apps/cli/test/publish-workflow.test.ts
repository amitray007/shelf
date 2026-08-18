import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ config: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'shelf-publish-workflow-'));
  roots.push(root);
  const file = join(root, 'idea.html');
  await writeFile(file, '<h1>Idea</h1>');
  return { config: join(root, 'config'), file };
}

const publishResult = {
  apiVersion: 'v1' as const,
  kind: 'file' as const,
  workspaceId: 'personal',
  artifactId: 'art_0123456789abcdefghijkl',
  revisionId: 'rev_0123456789abcdefghijkl',
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteCount: 13,
  fileCount: 1 as const,
  provenance: {
    classification: 'direct-publish' as const,
    observed: { actorId: 'actor-agent', operation: 'file.publish' as const },
  },
  publisherMetadata: {},
  requestId: 'request-publish',
  paths: {
    artifact: '/api/v1/artifacts/art_0123456789abcdefghijkl',
    revision: '/api/v1/revisions/rev_0123456789abcdefghijkl',
    content: '/api/v1/revisions/rev_0123456789abcdefghijkl/content',
  },
  replayed: false,
};

const folderPublishResult = {
  ...publishResult,
  kind: 'folder' as const,
  byteCount: 13,
  fileCount: 1,
  requestId: 'request-folder-publish',
  paths: {
    artifact: publishResult.paths.artifact,
    revision: publishResult.paths.revision,
    tree: '/api/v1/revisions/rev_0123456789abcdefghijkl/tree',
  },
};

const shareResult = {
  apiVersion: 'v1' as const,
  workspaceId: 'personal',
  shareId: 'shr_CCCCCCCCCCCCCCCCCCCCCC',
  artifactId: publishResult.artifactId,
  visibility: 'unlisted' as const,
  accessType: 'protected' as const,
  target: { mode: 'latest' as const },
  createdAt: '2026-08-18T12:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  status: 'active' as const,
  maxSessions: null,
  sessionsUsed: 0,
  sessionsRemaining: null,
  requestId: 'request-share',
  url: `/s/shr_CCCCCCCCCCCCCCCCCCCCCC#${'s'.repeat(43)}`,
  replayed: false,
};

describe('profile-backed shelf publish', () => {
  it('publishes a positional file through the default isolated profile and returns browsable URLs', async () => {
    const { config, file } = await fixture();
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_PERSONAL_TOKEN: 'personal-secret',
    };
    expect(
      await runCli(
        [
          'node',
          'shelf',
          'profiles',
          'set',
          'default',
          '--url',
          'https://shelf.example',
          '--workspace',
          'personal',
          '--credential-env',
          'SHELF_PERSONAL_TOKEN',
        ],
        { env, stdout() {}, stderr() {} },
      ),
    ).toBe(0);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetch = vi.fn(async () => Response.json(publishResult, { status: 201 }));
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'publish',
        file,
        '--title',
        'Keep this idea',
        '--description',
        'A small HTML concept for review.',
      ],
      {
        env,
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
      apiVersion: 'v1',
      operation: 'publish',
      status: 'complete',
      profile: 'default',
      publish: publishResult,
      share: null,
      urls: {
        artifact: 'https://shelf.example/artifacts/art_0123456789abcdefghijkl',
        revision:
          'https://shelf.example/artifacts/art_0123456789abcdefghijkl/revisions/rev_0123456789abcdefghijkl',
        share: null,
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://shelf.example/api/v1/workspaces/personal/artifacts',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer personal-secret' }),
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'idempotency-key': expect.any(String) }),
    );
    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect((form.get('file') as Blob).type).toBe('text/html');
    expect(form.get('publisherMetadata')).toBe(
      JSON.stringify({ title: 'Keep this idea', description: 'A small HTML concept for review.' }),
    );
  });

  it('requires agent-friendly title and description unless the user explicitly bypasses them', async () => {
    const { config, file } = await fixture();
    const env = { SHELF_CONFIG_DIR: config, SHELF_PERSONAL_TOKEN: 'personal-secret' };
    await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'default',
        '--url',
        'https://shelf.example',
        '--workspace',
        'personal',
        '--credential-env',
        'SHELF_PERSONAL_TOKEN',
      ],
      { env, stdout() {}, stderr() {} },
    );
    const stderr: string[] = [];
    const fetch = vi.fn();

    const exitCode = await runCli(['node', 'shelf', 'publish', file], {
      env,
      stdout() {},
      stderr: (chunk) => stderr.push(chunk),
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('--user-bypass');
  });

  it('dispatches a positional directory to the existing complete-folder transport', async () => {
    const { config, file } = await fixture();
    const directory = join(file, '..', 'project');
    await mkdir(directory);
    await writeFile(join(directory, 'idea.md'), '# Idea\n');
    const env = { SHELF_CONFIG_DIR: config, SHELF_WORK_TOKEN: 'work-secret' };
    expect(
      await runCli(
        [
          'node',
          'shelf',
          'profiles',
          'set',
          'work',
          '--url',
          'https://work.shelf.example',
          '--workspace',
          'personal',
          '--credential-env',
          'SHELF_WORK_TOKEN',
        ],
        { env, stdout() {}, stderr() {} },
      ),
    ).toBe(0);
    const stdout: string[] = [];
    const fetch = vi.fn(async () => Response.json(folderPublishResult, { status: 201 }));

    const exitCode = await runCli(
      ['node', 'shelf', 'publish', directory, '--profile', 'work', '--user-bypass'],
      {
        env,
        stdout: (chunk) => stdout.push(chunk),
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({
      status: 'complete',
      profile: 'work',
      publish: { kind: 'folder' },
    });
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://work.shelf.example/api/v1/workspaces/personal/folders',
    );
    const form = fetch.mock.calls[0]?.[1]?.body as FormData;
    expect([...form.keys()]).toEqual(['manifest', 'file']);
  });

  it('creates exactly one explicit latest share and returns its absolute capability URL', async () => {
    const { config, file } = await fixture();
    const env = { SHELF_CONFIG_DIR: config, SHELF_PERSONAL_TOKEN: 'personal-secret' };
    expect(
      await runCli(
        [
          'node',
          'shelf',
          'profiles',
          'set',
          'default',
          '--url',
          'https://shelf.example',
          '--workspace',
          'personal',
          '--credential-env',
          'SHELF_PERSONAL_TOKEN',
        ],
        { env, stdout() {}, stderr() {} },
      ),
    ).toBe(0);
    const stdout: string[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(publishResult, { status: 201 }))
      .mockResolvedValueOnce(Response.json(shareResult, { status: 201 }));

    const exitCode = await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
      env,
      stdout: (chunk) => stdout.push(chunk),
      stderr() {},
      fetch,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout[0] ?? '{}');
    expect(output).toMatchObject({
      status: 'complete',
      publish: { artifactId: publishResult.artifactId },
      share: shareResult,
      urls: {
        share: `https://shelf.example${shareResult.url}`,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/personal/artifacts/${publishResult.artifactId}/shares`,
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ accessType: 'protected', target: { mode: 'latest' } }),
      headers: expect.objectContaining({
        authorization: 'Bearer personal-secret',
        'idempotency-key': expect.any(String),
      }),
    });
  });

  it('never emits success before local recovery cleanup has completed', async () => {
    const { config, file } = await fixture();
    const data = join(config, '..', 'data');
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: data,
      SHELF_PERSONAL_TOKEN: 'personal-secret',
    };
    await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'default',
        '--url',
        'https://shelf.example',
        '--workspace',
        'personal',
        '--credential-env',
        'SHELF_PERSONAL_TOKEN',
      ],
      { env, stdout() {}, stderr() {} },
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(publishResult, { status: 201 }))
      .mockImplementationOnce(async () => {
        const operations = join(data, 'operations');
        const journal = (await readdir(operations)).find((name) => name.endsWith('.json'));
        expect(journal).toBeDefined();
        await mkdir(join(operations, `${journal as string}.lock`));
        return Response.json(shareResult, { status: 201 });
      });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
      env,
      fetch,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0] ?? '{}')).toHaveProperty('error.code');
  });

  it('reports a committed publish as partial and resumes only the failed share with stable idempotency', async () => {
    const { config, file } = await fixture();
    const data = join(config, '..', 'data');
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: data,
      SHELF_PERSONAL_TOKEN: 'personal-secret-canary',
    };
    expect(
      await runCli(
        [
          'node',
          'shelf',
          'profiles',
          'set',
          'default',
          '--url',
          'https://shelf.example',
          '--workspace',
          'personal',
          '--credential-env',
          'SHELF_PERSONAL_TOKEN',
        ],
        { env, stdout() {}, stderr() {} },
      ),
    ).toBe(0);

    const firstStdout: string[] = [];
    const firstStderr: string[] = [];
    const firstFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(publishResult, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'Share service is temporarily unavailable.',
              retryable: true,
              requestId: 'request-share-failed',
            },
          },
          { status: 503 },
        ),
      );
    const firstExit = await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
      env,
      stdout: (chunk) => firstStdout.push(chunk),
      stderr: (chunk) => firstStderr.push(chunk),
      fetch: firstFetch,
    });

    expect(firstExit).toBe(6);
    expect(firstStdout).toEqual([]);
    expect(JSON.parse(firstStderr[0] ?? '{}')).toMatchObject({
      apiVersion: 'v1',
      operation: 'publish',
      status: 'partial',
      profile: 'default',
      publish: { artifactId: publishResult.artifactId, revisionId: publishResult.revisionId },
      share: null,
      urls: { artifact: expect.any(String), revision: expect.any(String), share: null },
      error: { code: 'SERVICE_UNAVAILABLE', retryable: true },
    });
    expect(firstStderr.join('')).not.toContain('personal-secret-canary');
    const journalFiles = await readdir(join(data, 'operations'));
    expect(journalFiles).toHaveLength(1);
    const journal = await readFile(join(data, 'operations', journalFiles[0] as string), 'utf8');
    expect(journal).not.toMatch(/personal-secret-canary|\/s\/shr_|#{1}[A-Za-z0-9_-]{32,128}/u);
    await writeFile(
      join(data, 'operations', `${journalFiles[0] as string}.lock`),
      `${JSON.stringify({ version: 1, pid: 2_147_483_647, token: crypto.randomUUID() })}\n`,
      { mode: 0o600 },
    );
    const firstShareKey = new Headers(firstFetch.mock.calls[1]?.[1]?.headers).get(
      'idempotency-key',
    );

    const retryStdout: string[] = [];
    const retryStderr: string[] = [];
    const retryFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ...shareResult, replayed: true }, { status: 201 }),
    );
    const retryExit = await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
      env,
      stdout: (chunk) => retryStdout.push(chunk),
      stderr: (chunk) => retryStderr.push(chunk),
      fetch: retryFetch,
    });

    expect(retryStderr).toEqual([]);
    expect(retryExit).toBe(0);
    expect(retryFetch).toHaveBeenCalledOnce();
    expect(retryFetch.mock.calls[0]?.[0].toString()).toContain('/shares');
    expect(new Headers(retryFetch.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      firstShareKey,
    );
    expect(JSON.parse(retryStdout[0] ?? '{}')).toMatchObject({
      status: 'complete',
      publish: publishResult,
      share: { replayed: true },
    });
    expect(await readdir(join(data, 'operations'))).toEqual([]);

    const afterDeliveryFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { ...publishResult, revisionId: 'rev_ZZZZZZZZZZZZZZZZZZZZZZ' },
        { status: 201 },
      ),
    );
    const afterDeliveryExit = await runCli(['node', 'shelf', 'publish', file, '--user-bypass'], {
      env,
      stdout() {},
      stderr() {},
      fetch: afterDeliveryFetch,
    });
    expect(afterDeliveryExit).toBe(0);
    expect(afterDeliveryFetch.mock.calls[0]?.[0].toString()).not.toContain('/shares');
  });

  it('never replays an old publish after the source file changes', async () => {
    const { config, file } = await fixture();
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: join(config, '..', 'data'),
      SHELF_PERSONAL_TOKEN: 'personal-secret',
    };
    await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'default',
        '--url',
        'https://shelf.example',
        '--workspace',
        'personal',
        '--credential-env',
        'SHELF_PERSONAL_TOKEN',
      ],
      { env, stdout() {}, stderr() {} },
    );
    const unavailable = {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Share service is temporarily unavailable.',
        retryable: true,
        requestId: 'request-share-failed',
      },
    };
    const firstFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(publishResult, { status: 201 }))
      .mockResolvedValueOnce(Response.json(unavailable, { status: 503 }));
    expect(
      await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
        env,
        fetch: firstFetch,
        stdout() {},
        stderr() {},
      }),
    ).not.toBe(0);

    await writeFile(file, '<h1>Changed idea</h1>');
    const changedPublish = {
      ...publishResult,
      revisionId: 'rev_ZZZZZZZZZZZZZZZZZZZZZZ',
      byteCount: 21,
    };
    const retryFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(changedPublish, { status: 201 }))
      .mockResolvedValueOnce(Response.json(shareResult, { status: 201 }));

    expect(
      await runCli(['node', 'shelf', 'publish', file, '--share', '--user-bypass'], {
        env,
        fetch: retryFetch,
        stdout() {},
        stderr() {},
      }),
    ).toBe(0);
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(retryFetch.mock.calls[0]?.[0].toString()).toContain('/artifacts');
    const form = retryFetch.mock.calls[0]?.[1]?.body as FormData;
    expect(await (form.get('file') as Blob).text()).toBe('<h1>Changed idea</h1>');
  });

  it('linearizes concurrent local retries onto one publish idempotency key', async () => {
    const { config, file } = await fixture();
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: join(config, '..', 'data'),
      SHELF_PERSONAL_TOKEN: 'personal-secret',
    };
    await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'default',
        '--url',
        'https://shelf.example',
        '--workspace',
        'personal',
        '--credential-env',
        'SHELF_PERSONAL_TOKEN',
      ],
      { env, stdout() {}, stderr() {} },
    );
    let releaseFetches: (() => void) | undefined;
    const bothFetchesStarted = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      if (fetch.mock.calls.length === 2) releaseFetches?.();
      await bothFetchesStarted;
      return Response.json(publishResult, { status: 201 });
    });

    const exits = await Promise.all(
      [0, 1].map(() =>
        runCli(['node', 'shelf', 'publish', file, '--user-bypass'], {
          env,
          stdout() {},
          stderr() {},
          fetch,
        }),
      ),
    );

    expect(exits).toEqual([0, 0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get('idempotency-key')),
    ).toEqual([expect.any(String), expect.any(String)]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get('idempotency-key'),
    );
  });

  it('keeps personal and work installation, workspace, and credential authority isolated', async () => {
    const { config, file } = await fixture();
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: join(config, '..', 'data'),
      PERSONAL_TOKEN: 'personal-authority',
      WORK_TOKEN: 'work-authority',
    };
    for (const [name, url, workspace, variable] of [
      ['personal', 'https://personal.shelf.example', 'personal-space', 'PERSONAL_TOKEN'],
      ['work', 'https://work.shelf.example', 'work-space', 'WORK_TOKEN'],
    ] as const) {
      expect(
        await runCli(
          [
            'node',
            'shelf',
            'profiles',
            'set',
            name,
            '--url',
            url,
            '--workspace',
            workspace,
            '--credential-env',
            variable,
          ],
          { env, stdout() {}, stderr() {} },
        ),
      ).toBe(0);
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const url = new URL(request.toString());
      const workspaceId = url.pathname.includes('personal-space') ? 'personal-space' : 'work-space';
      return Response.json({ ...publishResult, workspaceId }, { status: 201 });
    });

    for (const profile of ['personal', 'work']) {
      expect(
        await runCli(['node', 'shelf', 'publish', file, '--profile', profile, '--user-bypass'], {
          env,
          fetch,
          stdout() {},
          stderr() {},
        }),
      ).toBe(0);
    }

    expect(fetch.mock.calls.map(([request]) => request.toString())).toEqual([
      'https://personal.shelf.example/api/v1/workspaces/personal-space/artifacts',
      'https://work.shelf.example/api/v1/workspaces/work-space/artifacts',
    ]);
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')),
    ).toEqual(['Bearer personal-authority', 'Bearer work-authority']);
  });

  it('clears a response-loss journal after a semantic idempotency conflict', async () => {
    const { config, file } = await fixture();
    const data = join(config, '..', 'data');
    const env = {
      SHELF_CONFIG_DIR: config,
      SHELF_DATA_DIR: data,
      SHELF_PERSONAL_TOKEN: 'personal-secret',
    };
    await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'default',
        '--url',
        'https://shelf.example',
        '--workspace',
        'personal',
        '--credential-env',
        'SHELF_PERSONAL_TOKEN',
      ],
      { env, stdout() {}, stderr() {} },
    );
    const lostResponse = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('response lost');
    });
    expect(
      await runCli(['node', 'shelf', 'publish', file, '--user-bypass'], {
        env,
        fetch: lostResponse,
        stdout() {},
        stderr() {},
      }),
    ).toBe(6);
    const originalKey = new Headers(lostResponse.mock.calls[0]?.[1]?.headers).get(
      'idempotency-key',
    );

    const conflict = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'The key already names another publish.',
            retryable: false,
            requestId: 'request-conflict',
          },
        },
        { status: 409 },
      ),
    );
    expect(
      await runCli(['node', 'shelf', 'publish', file, '--user-bypass'], {
        env,
        fetch: conflict,
        stdout() {},
        stderr() {},
      }),
    ).toBe(5);
    expect(new Headers(conflict.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      originalKey,
    );
    expect(await readdir(join(data, 'operations'))).toEqual([]);

    await writeFile(file, '<h1>Changed idea</h1>');
    const next = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ ...publishResult, byteCount: 21 }, { status: 201 }),
    );
    expect(
      await runCli(['node', 'shelf', 'publish', file, '--user-bypass'], {
        env,
        fetch: next,
        stdout() {},
        stderr() {},
      }),
    ).toBe(0);
    expect(new Headers(next.mock.calls[0]?.[1]?.headers).get('idempotency-key')).not.toBe(
      originalKey,
    );
  });
});
