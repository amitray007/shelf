import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  share: 'shr_CCCCCCCCCCCCCCCCCCCCCC',
};
const capabilityUrl = `/s/${ids.share}#${'s'.repeat(43)}`;

const summary = {
  apiVersion: 'v1',
  workspaceId: 'workspace-main',
  shareId: ids.share,
  artifactId: ids.artifact,
  visibility: 'unlisted',
  accessType: 'protected',
  target: { mode: 'latest' },
  createdAt: '2026-08-17T12:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  status: 'active',
  maxSessions: null,
  sessionsUsed: 0,
  sessionsRemaining: null,
  url: capabilityUrl,
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

describe('shelf shares', () => {
  it('documents access, expiry, limits, targets, and examples in command help', async () => {
    const output = runtime(vi.fn() as typeof globalThis.fetch);

    const exitCode = await runCli(['node', 'shelf', 'shares', 'create', '--help'], output.value);

    expect(exitCode).toBe(0);
    expect(output.stdout.value()).toContain('--access <protected|public>');
    expect(output.stdout.value()).toContain('--expires-in <preset>');
    expect(output.stdout.value()).toContain('--max-sessions <count>');
    expect(output.stdout.value()).toContain('Targets default to Latest');
    expect(output.stdout.value()).toContain('non-confidential');
  });

  it('creates an explicit latest share and prints its capability URL once', async () => {
    const result = {
      ...summary,
      requestId: 'request-create-share',
      url: capabilityUrl,
      replayed: false,
    };
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--idempotency-key',
        'share-launch-notes',
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.value())).toEqual(result);
    expect(
      output.stdout.value().match(new RegExp(capabilityUrl.replaceAll('/', '\\/'), 'gu')),
    ).toHaveLength(1);
    expect(output.stderr.value()).toBe('');
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/workspace-main/artifacts/${ids.artifact}/shares`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: JSON.stringify({ accessType: 'protected', target: { mode: 'latest' } }),
      headers: expect.objectContaining({
        authorization: 'Bearer secret-token',
        'idempotency-key': 'share-launch-notes',
      }),
    });
  });

  it('creates a pinned expiring share with an exact revision target', async () => {
    const expiresAt = '2026-08-24T12:00:00.000Z';
    const result = {
      ...summary,
      target: { mode: 'pinned', revisionId: ids.revision },
      expiresAt,
      requestId: 'request-create-pinned-share',
      url: capabilityUrl,
      replayed: false,
    };
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--revision',
        ids.revision,
        '--expires-at',
        expiresAt,
        '--idempotency-key',
        'share-pinned-launch-notes',
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        accessType: 'protected',
        target: { mode: 'pinned', revisionId: ids.revision },
        expiresAt,
      }),
    });
  });

  it('creates a permanent public share by default', async () => {
    const result = {
      apiVersion: 'v1' as const,
      workspaceId: summary.workspaceId,
      shareId: summary.shareId,
      artifactId: summary.artifactId,
      visibility: 'unlisted' as const,
      accessType: 'public' as const,
      publicCode: 'AbCdEf0123_-',
      target: { mode: 'latest' as const },
      createdAt: summary.createdAt,
      expiresAt: null,
      revokedAt: null,
      status: 'active' as const,
      url: '/s/AbCdEf0123_-',
      requestId: 'request-create-public-share',
      replayed: false,
    };
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--access',
        'public',
        '--idempotency-key',
        'public-share',
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ accessType: 'public', target: { mode: 'latest' } }),
    });
    expect(output.stdout.value()).toContain('/s/AbCdEf0123_-');
  });

  it('creates a session-limited protected share with a named expiry', async () => {
    const result = {
      ...summary,
      maxSessions: 5,
      sessionsRemaining: 5,
      expiresAt: '2026-08-18T12:00:00.000Z',
      requestId: 'request-create-limited-share',
      replayed: false,
    };
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--expires-in',
        '24hr',
        '--max-sessions',
        '5',
        '--idempotency-key',
        'limited-share',
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        accessType: 'protected',
        target: { mode: 'latest' },
        expiresIn: '24hr',
        maxSessions: 5,
      }),
    });
  });

  it('rejects a create response whose capability URL names another share', async () => {
    const mismatchedUrl = `/s/shr_ZZZZZZZZZZZZZZZZZZZZZZ#${'z'.repeat(43)}`;
    const fetch = vi.fn(async () =>
      Response.json(
        {
          ...summary,
          requestId: 'request-mismatched-share',
          url: mismatchedUrl,
          replayed: false,
        },
        { status: 201 },
      ),
    );
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--idempotency-key',
        'mismatched-response',
      ],
      output.value,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout.value()).toBe('');
    expect(output.stderr.value()).not.toContain(mismatchedUrl);
  });

  it('rejects a cross-workspace share response instead of printing it', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          ...summary,
          workspaceId: 'workspace-other',
          requestId: 'request-cross-workspace-share',
          url: capabilityUrl,
          replayed: false,
        },
        { status: 201 },
      ),
    );
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'create',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
        '--idempotency-key',
        'cross-workspace-response',
      ],
      output.value,
    );

    expect(exitCode).toBe(1);
    expect(output.stdout.value()).toBe('');
  });

  it('gets or repairs both prepared defaults for one artifact', async () => {
    const defaults = {
      apiVersion: 'v1' as const,
      workspaceId: 'workspace-main',
      artifactId: ids.artifact,
      protected: summary,
      public: {
        apiVersion: 'v1' as const,
        workspaceId: 'workspace-main',
        shareId: 'shr_DDDDDDDDDDDDDDDDDDDDDD',
        artifactId: ids.artifact,
        visibility: 'unlisted' as const,
        accessType: 'public' as const,
        publicCode: 'PublicCode12',
        target: { mode: 'latest' as const },
        createdAt: summary.createdAt,
        expiresAt: null,
        revokedAt: null,
        status: 'active' as const,
        url: '/s/PublicCode12',
      },
    };
    const fetch = vi.fn(async () => Response.json(defaults));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'defaults',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--artifact',
        ids.artifact,
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.value())).toEqual(defaults);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/workspace-main/artifacts/${ids.artifact}/shares/defaults`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('lists a bounded page with its reusable capability URL', async () => {
    const page = {
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      items: [summary],
      nextCursor: 'next-page',
    };
    const fetch = vi.fn(async () => Response.json(page));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--limit',
        '25',
        '--cursor',
        'current-page',
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.value())).toEqual(page);
    expect(output.stdout.value()).toContain(capabilityUrl);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://shelf.example/api/v1/workspaces/workspace-main/shares?limit=25&cursor=current-page',
    );
  });

  it('revokes one share while returning its canonical management URL', async () => {
    const revoked = { ...summary, revokedAt: '2026-08-17T12:05:00.000Z' };
    const fetch = vi.fn(async () => Response.json(revoked));
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'revoke',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--share',
        ids.share,
      ],
      output.value,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdout.value())).toEqual(revoked);
    expect(output.stdout.value()).toContain(capabilityUrl);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/workspace-main/shares/${ids.share}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', redirect: 'manual' });
  });

  it.each([
    ['create artifact', ['create', '--artifact', 'not-an-artifact', '--idempotency-key', 'key']],
    [
      'create revision',
      [
        'create',
        '--artifact',
        ids.artifact,
        '--revision',
        'not-a-revision',
        '--idempotency-key',
        'key',
      ],
    ],
    ['list limit', ['list', '--limit', '101']],
    ['revoke share', ['revoke', '--share', 'not-a-share']],
    [
      'conflicting expiry',
      [
        'create',
        '--artifact',
        ids.artifact,
        '--expires-in',
        '24hr',
        '--expires-at',
        '2026-08-24T12:00:00.000Z',
        '--idempotency-key',
        'key',
      ],
    ],
    [
      'public session limit',
      [
        'create',
        '--artifact',
        ids.artifact,
        '--access',
        'public',
        '--max-sessions',
        '2',
        '--idempotency-key',
        'key',
      ],
    ],
  ])('rejects an invalid %s before making a network request', async (_case, command) => {
    const fetch = vi.fn();
    const output = runtime(fetch as typeof globalThis.fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        ...command,
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
      ],
      output.value,
    );

    expect(exitCode).toBe(2);
    expect(output.stdout.value()).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts a capability URL from a remote error', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: `Retry ${capabilityUrl}`,
            retryable: true,
            requestId: 'request-failed-share',
          },
        },
        { status: 503 },
      ),
    );
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
      ],
      output.value,
    );

    expect(exitCode).toBe(6);
    expect(output.stdout.value()).toBe('');
    expect(output.stderr.value()).not.toContain(capabilityUrl);
    expect(output.stderr.value()).toContain('[REDACTED_SHARE_URL]');
  });

  it('refuses a cross-origin redirect before forwarding the bearer credential', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://attacker.example/collect' },
        }),
    );
    const output = runtime(fetch);

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'shares',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
      ],
      output.value,
    );

    expect(exitCode).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('https://shelf.example/');
  });

  it('uses only the public contracts boundary for share management', async () => {
    const sources = await Promise.all(
      ['../src/client.ts', '../src/commands/shares.ts', '../src/index.ts'].map((path) =>
        readFile(new URL(path, import.meta.url), 'utf8'),
      ),
    );

    expect(sources.join('\n')).not.toMatch(/@shelf\/core|apps\/api|\.\.\/\.\.\/api/);
  });
});
