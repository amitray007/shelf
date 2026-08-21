import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

const ids = {
  artifact: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revision: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  thread: 'thread_01',
};

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

/** Configures one environment-credential profile and returns its config directory. */
async function configuredProfile(): Promise<string> {
  const configDirectory = await temporaryDirectory('shelf-cli-remote-profile-');
  const exitCode = await runCli(
    [
      'node',
      'shelf',
      'profiles',
      'set',
      'default',
      '--url',
      'https://profile.example',
      '--workspace',
      'profile-workspace',
      '--credential-env',
      'SHELF_PROFILE_TOKEN',
    ],
    { env: { SHELF_CONFIG_DIR: configDirectory }, stdout() {}, stderr() {} },
  );
  expect(exitCode).toBe(0);
  return configDirectory;
}

function profileEnv(configDirectory: string) {
  return { SHELF_CONFIG_DIR: configDirectory, SHELF_PROFILE_TOKEN: 'profile-secret' };
}

const artifactPage = { apiVersion: 'v1', items: [], nextCursor: null };

describe('shelf remote commands with --profile', () => {
  it.each([
    [
      'artifacts list',
      ['artifacts', 'list'],
      'https://profile.example/api/v1/workspaces/profile-workspace/artifacts?limit=20&sort=updated&order=desc',
      artifactPage,
    ],
    [
      'shares list',
      ['shares', 'list'],
      'https://profile.example/api/v1/workspaces/profile-workspace/shares?limit=20',
      { apiVersion: 'v1', workspaceId: 'profile-workspace', items: [], nextCursor: null },
    ],
    [
      'folders tree',
      ['folders', 'tree', '--revision', ids.revision],
      `https://profile.example/api/v1/revisions/${ids.revision}/tree?limit=100`,
      {
        apiVersion: 'v1',
        revisionId: ids.revision,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 0,
        fileCount: 0,
        items: [],
        nextCursor: null,
      },
    ],
  ] as const)(
    'resolves the installation URL, workspace, and credential for %s',
    async (_name, command, expectedUrl, payload) => {
      const configDirectory = await configuredProfile();
      const stdout = capture();
      const fetch = vi.fn(async () => Response.json(payload));

      const exitCode = await runCli(['node', 'shelf', ...command, '--profile', 'default'], {
        env: profileEnv(configDirectory),
        stdout: stdout.write,
        stderr() {},
        fetch,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.value())).toEqual(payload);
      expect(fetch.mock.calls[0]?.[0].toString()).toBe(expectedUrl);
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
        'Bearer profile-secret',
      );
    },
  );

  it('resolves a profile for a comments moderation command', async () => {
    const configDirectory = await configuredProfile();
    const post = {
      postId: 'post_01',
      threadId: ids.thread,
      body: 'Fixed.',
      author: {
        kind: 'actor',
        participantId: 'participant_01',
        actorId: 'actor-owner',
        displayName: 'Owner',
      },
      permissions: { canEdit: true, canDelete: true, canModerate: true },
      createdAt: '2026-08-18T12:00:00.000Z',
      editedAt: null,
      deletedAt: null,
      hiddenAt: null,
    };
    const fetch = vi.fn(async () => Response.json(post, { status: 201 }));
    const stdout = capture();

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'comments',
        'reply',
        '--profile',
        'default',
        '--artifact',
        ids.artifact,
        '--thread',
        ids.thread,
        '--body',
        'Fixed.',
      ],
      { env: profileEnv(configDirectory), stdout: stdout.write, stderr() {}, fetch },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(post);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://profile.example/api/v1/workspaces/profile-workspace/artifacts/${ids.artifact}/comments/threads/${ids.thread}/replies`,
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer profile-secret',
    );
  });

  it('resolves a profile for a revisions command that ignores the profile workspace', async () => {
    const configDirectory = await configuredProfile();
    const root = await temporaryDirectory('shelf-cli-profile-download-');
    const output = join(root, 'artifact.bin');
    const fetch = vi.fn(
      async () =>
        new Response('exact bytes', {
          headers: { 'content-length': '11', 'content-type': 'application/octet-stream' },
        }),
    );

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'revisions',
        'download',
        '--profile',
        'default',
        '--revision',
        ids.revision,
        '--output',
        output,
      ],
      { env: profileEnv(configDirectory), stdout() {}, stderr() {}, fetch },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(output, 'utf8')).toBe('exact bytes');
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://profile.example/api/v1/revisions/${ids.revision}/content`,
    );
  });

  it.each([
    ['--url', ['--url', 'https://other.example']],
    ['--workspace', ['--workspace', 'other-workspace']],
    ['--allow-insecure-loopback', ['--allow-insecure-loopback']],
  ] as const)('refuses to mix --profile with %s', async (_name, conflicting) => {
    const configDirectory = await configuredProfile();
    const stderr = capture();
    const fetch = vi.fn();

    const exitCode = await runCli(
      ['node', 'shelf', 'artifacts', 'list', '--profile', 'default', ...conflicting],
      { env: profileEnv(configDirectory), stdout() {}, stderr: stderr.write, fetch },
    );

    expect(exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(stderr.value()).toContain('--profile cannot be combined');
  });

  it('reports an unconfigured profile without contacting the API', async () => {
    const configDirectory = await temporaryDirectory('shelf-cli-missing-profile-');
    const stderr = capture();
    const fetch = vi.fn();

    const exitCode = await runCli(['node', 'shelf', 'shares', 'list', '--profile', 'absent'], {
      env: { SHELF_CONFIG_DIR: configDirectory },
      stdout() {},
      stderr: stderr.write,
      fetch,
    });

    expect(exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr.value()).toContain('is not configured');
  });

  it('keeps --url and SHELF_TOKEN working unchanged without a profile', async () => {
    const fetch = vi.fn(async () => Response.json(artifactPage));
    const stdout = capture();

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout: stdout.write, stderr() {}, fetch },
    );

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[0].toString()).toContain('https://shelf.example');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer secret-token',
    );
  });

  it('requires --url or --profile and reports a missing workspace', async () => {
    const stderr = capture();
    const fetch = vi.fn();

    expect(
      await runCli(['node', 'shelf', 'artifacts', 'list', '--workspace', 'workspace-main'], {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(2);
    expect(stderr.value()).toContain('--url or --profile is required');

    const missingWorkspace = capture();
    expect(
      await runCli(['node', 'shelf', 'artifacts', 'list', '--url', 'https://shelf.example'], {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr: missingWorkspace.write,
        fetch,
      }),
    ).toBe(2);
    expect(missingWorkspace.value()).toContain('--workspace or --profile is required.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('documents profile usage in top-level and command help', async () => {
    const topLevel = capture();
    expect(
      await runCli(['node', 'shelf', '--help'], {
        env: {},
        stdout: topLevel.write,
        stderr() {},
      }),
    ).toBe(0);
    expect(topLevel.value()).toContain('--profile <name>');
    expect(topLevel.value()).toContain('Mixing --profile with --url');

    const command = capture();
    expect(
      await runCli(['node', 'shelf', 'artifacts', 'list', '--help'], {
        env: {},
        stdout: command.write,
        stderr() {},
      }),
    ).toBe(0);
    expect(command.value()).toContain('--profile <name>');
  });
});

describe('default profile fallback', () => {
  it('uses the profile named "default" for a bare command', async () => {
    const configDirectory = await configuredProfile();
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(artifactPage));

    const exitCode = await runCli(['node', 'shelf', 'artifacts', 'list'], {
      env: profileEnv(configDirectory),
      stdout: stdout.write,
      stderr() {},
      fetch,
    });

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://profile.example/api/v1/workspaces/profile-workspace/artifacts?limit=20&sort=updated&order=desc',
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer profile-secret',
    );
  });

  it('keeps the usage error when no default profile is configured', async () => {
    const configDirectory = await temporaryDirectory('shelf-cli-no-default-');
    const stderr = capture();

    const exitCode = await runCli(['node', 'shelf', 'artifacts', 'list'], {
      env: { SHELF_CONFIG_DIR: configDirectory },
      stdout() {},
      stderr: stderr.write,
    });

    expect(exitCode).toBe(2);
    expect(stderr.value()).toContain('configure a profile named');
  });

  it('does not fall back when explicit context flags are present', async () => {
    const configDirectory = await configuredProfile();
    const stderr = capture();

    const exitCode = await runCli(
      ['node', 'shelf', 'artifacts', 'list', '--workspace', 'other-workspace'],
      { env: profileEnv(configDirectory), stdout() {}, stderr: stderr.write },
    );

    expect(exitCode).toBe(2);
    expect(stderr.value()).toContain('--url');
  });
});
