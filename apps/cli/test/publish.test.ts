import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fileFixture(contents = 'hello shelf') {
  const root = await mkdtemp(join(tmpdir(), 'shelf-cli-test-'));
  roots.push(root);
  const path = join(root, 'artifact.txt');
  await writeFile(path, contents);
  return path;
}

const publishResult = {
  apiVersion: 'v1' as const,
  kind: 'file' as const,
  workspaceId: 'workspace-main',
  artifactId: 'art_0123456789abcdefghijkl',
  revisionId: 'rev_0123456789abcdefghijkl',
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteCount: 11,
  fileCount: 1 as const,
  provenance: {
    classification: 'direct-publish' as const,
    observed: { actorId: 'actor-agent', operation: 'file.publish' as const },
  },
  publisherMetadata: { source: 'cli' },
  requestId: 'request-123',
  paths: {
    artifact: '/api/v1/artifacts/art_0123456789abcdefghijkl',
    revision: '/api/v1/revisions/rev_0123456789abcdefghijkl',
    content: '/api/v1/revisions/rev_0123456789abcdefghijkl/content',
  },
  replayed: false,
};

function capture() {
  let value = '';
  return {
    write(chunk: string) {
      value += chunk;
    },
    value: () => value,
  };
}

function argv(file: string, ...extra: string[]) {
  return [
    'node',
    'shelf',
    'publish',
    '--url',
    'https://shelf.example',
    '--workspace',
    'workspace-main',
    '--file',
    file,
    '--idempotency-key',
    'publish-1',
    ...extra,
  ];
}

describe('shelf publish', () => {
  it('returns the usage exit class and one canonical error when required arguments are missing', async () => {
    const stdout = capture();
    const stderr = capture();

    const exitCode = await runCli(['node', 'shelf', 'publish'], {
      env: {},
      stdout: stdout.write,
      stderr: stderr.write,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value()).toBe('');
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: 'INVALID_REQUEST',
        retryable: false,
        requestId: 'cli',
      },
    });
    expect(stderr.value().trim().split('\n')).toHaveLength(1);
  });

  it('publishes with explicit inputs and writes the canonical result as one JSON document', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () =>
      Response.json(publishResult, {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const exitCode = await runCli(argv(file, '--metadata', 'source=cli'), {
      env: { SHELF_TOKEN: 'secret-token' },
      stdout: stdout.write,
      stderr: stderr.write,
      fetch,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(publishResult);
    expect(stdout.value().trim().split('\n')).toHaveLength(1);
    expect(stderr.value()).toBe('');
    expect(fetch).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetch.mock.calls[0] ?? [];
    expect(requestUrl?.toString()).toBe(
      'https://shelf.example/api/v1/workspaces/workspace-main/artifacts',
    );
    expect(requestInit).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer secret-token',
        'idempotency-key': 'publish-1',
      },
    });
    const body = requestInit?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect([...form.keys()]).toEqual(['publisherMetadata', 'file']);
    expect(form.get('publisherMetadata')).toBe('{"source":"cli"}');
    expect((form.get('file') as Blob).type).toBe('text/plain');
    expect(await (form.get('file') as Blob).text()).toBe('hello shelf');
    expect(JSON.stringify([...form.entries()])).not.toMatch(/share|visibility/);
  });

  it('publishes another revision through the shelf command and stable artifact URL', async () => {
    const file = await fileFixture('version two');
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(publishResult, { status: 201 }));

    const exitCode = await runCli(argv(file, '--artifact', 'art_0123456789abcdefghijkl'), {
      env: { SHELF_TOKEN: 'secret-token' },
      stdout: stdout.write,
      stderr() {},
      fetch,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(publishResult);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://shelf.example/api/v1/workspaces/workspace-main/artifacts/art_0123456789abcdefghijkl/revisions',
    );
  });

  it('does not accept credentials as an argument or infer a token', async () => {
    const file = await fileFixture();
    const fetch = vi.fn();
    for (const [args, env] of [
      [argv(file, '--token', 'literal-secret'), { SHELF_TOKEN: 'env-secret' }],
      [argv(file), {}],
    ] as const) {
      const stdout = capture();
      const stderr = capture();
      expect(await runCli(args, { env, stdout: stdout.write, stderr: stderr.write, fetch })).toBe(
        2,
      );
      expect(stdout.value()).toBe('');
      expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['AUTHENTICATION_REQUIRED', 3],
    ['AUTHORIZATION_DENIED', 4],
    ['INVALID_REQUEST', 5],
    ['IDEMPOTENCY_CONFLICT', 5],
    ['SERVICE_UNAVAILABLE', 6],
    ['INTERNAL_ERROR', 1],
  ] as const)(
    'maps %s to stable exit class %i and preserves the canonical error',
    async (code, expected) => {
      const file = await fileFixture();
      const stdout = capture();
      const stderr = capture();
      const envelope = {
        error: {
          code,
          message: 'request failed',
          retryable: code === 'SERVICE_UNAVAILABLE',
          requestId: 'req-1',
        },
      };
      const fetch = vi.fn(async () => Response.json(envelope, { status: 400 }));

      expect(
        await runCli(argv(file), {
          env: { SHELF_TOKEN: 'secret-token' },
          stdout: stdout.write,
          stderr: stderr.write,
          fetch,
        }),
      ).toBe(expected);
      expect(stdout.value()).toBe('');
      expect(JSON.parse(stderr.value())).toEqual(envelope);
    },
  );

  it('redacts the environment credential from remote errors', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: 'secret-token must never be echoed',
            retryable: false,
            requestId: 'req-1',
            details: [{ reason: 'received secret-token' }],
          },
        },
        { status: 400 },
      ),
    );

    expect(
      await runCli(argv(file), {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(5);
    expect(stdout.value()).toBe('');
    expect(stderr.value()).not.toContain('secret-token');
    expect(stderr.value()).toContain('[REDACTED]');
  });

  it('never prints false success for local-read, network, or invalid-success failures', async () => {
    const missing = join(tmpdir(), `shelf-missing-${Date.now()}`);
    const goodFile = await fileFixture();
    const cases: Array<{ args: string[]; fetch: typeof globalThis.fetch; exit: number }> = [
      { args: argv(missing), fetch: vi.fn(), exit: 2 },
      {
        args: argv(goodFile),
        fetch: vi.fn(async () => {
          throw new Error('offline');
        }),
        exit: 6,
      },
      {
        args: argv(goodFile),
        fetch: vi.fn(async () => Response.json({ ok: true }, { status: 201 })),
        exit: 1,
      },
    ];
    for (const item of cases) {
      const stdout = capture();
      const stderr = capture();
      expect(
        await runCli(item.args, {
          env: { SHELF_TOKEN: 'secret-token' },
          stdout: stdout.write,
          stderr: stderr.write,
          fetch: item.fetch,
        }),
      ).toBe(item.exit);
      expect(stdout.value()).toBe('');
      expect(JSON.parse(stderr.value())).toHaveProperty('error.code');
    }
  });

  it('rejects remote HTTP and loopback HTTP without the explicit development opt-in', async () => {
    const file = await fileFixture();
    const fetch = vi.fn();
    for (const url of ['http://shelf.example', 'http://127.0.0.1:3000']) {
      const stderr = capture();
      const args = argv(file);
      args[args.indexOf('https://shelf.example')] = url;
      expect(
        await runCli(args, {
          env: { SHELF_TOKEN: 'secret-token' },
          stdout() {},
          stderr: stderr.write,
          fetch,
        }),
      ).toBe(2);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin redirect before forwarding credentials', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: 'https://other.example/upload' } }),
    );

    expect(
      await runCli(argv(file), {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(stdout.value()).toBe('');
    expect(stderr.value()).not.toContain('secret-token');
  });

  it('turns an unexpected client exception into one canonical internal error', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: 'http://[' } }),
    );

    expect(
      await runCli(argv(file), {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(1);
    expect(stdout.value()).toBe('');
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: false, requestId: 'cli' },
    });
  });

  it('rejects an oversized response without buffering it as a valid result', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 201 }));

    expect(
      await runCli(argv(file), {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(1);
    expect(stdout.value()).toBe('');
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });

  it('reports an idempotent replay without changing the canonical response', async () => {
    const file = await fileFixture();
    const stdout = capture();
    const replay = { ...publishResult, replayed: true };
    const fetch = vi.fn(async () => Response.json(replay, { status: 201 }));

    expect(
      await runCli(argv(file), {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      }),
    ).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(replay);
  });
});
