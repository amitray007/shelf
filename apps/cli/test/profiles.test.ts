import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'shelf-cli-profile-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('shelf profiles', () => {
  it('stores a non-secret environment credential reference with owner-only permissions', async () => {
    const configDirectory = await temporaryDirectory();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secret = 'shelf_secret_that_must_not_be_persisted';

    const exitCode = await runCli(
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
      {
        env: {
          SHELF_CONFIG_DIR: configDirectory,
          SHELF_PERSONAL_TOKEN: secret,
        },
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
      apiVersion: 'v1',
      profile: {
        name: 'default',
        installationUrl: 'https://shelf.example',
        workspaceId: 'personal',
        allowInsecureLoopback: false,
        credential: { type: 'environment', variable: 'SHELF_PERSONAL_TOKEN' },
      },
    });

    const configPath = join(configDirectory, 'profiles.json');
    const persisted = await readFile(configPath, 'utf8');
    expect(persisted).not.toContain(secret);
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      profiles: {
        default: {
          installationUrl: 'https://shelf.example',
          workspaceId: 'personal',
          allowInsecureLoopback: false,
          credential: { type: 'environment', variable: 'SHELF_PERSONAL_TOKEN' },
        },
      },
    });
    expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('lists named contexts without resolving or printing their credentials', async () => {
    const configDirectory = await temporaryDirectory();
    const env = {
      SHELF_CONFIG_DIR: configDirectory,
      SHELF_PERSONAL_TOKEN: 'personal_secret',
      SHELF_WORK_TOKEN: 'work_secret',
    };

    for (const [name, workspace, variable] of [
      ['work', 'work-space', 'SHELF_WORK_TOKEN'],
      ['personal', 'personal-space', 'SHELF_PERSONAL_TOKEN'],
    ] as const) {
      const exitCode = await runCli(
        [
          'node',
          'shelf',
          'profiles',
          'set',
          name,
          '--url',
          `https://${name}.example`,
          '--workspace',
          workspace,
          '--credential-env',
          variable,
        ],
        { env, stdout() {}, stderr() {} },
      );
      expect(exitCode).toBe(0);
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(['node', 'shelf', 'profiles', 'list'], {
      env,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? '{}')).toEqual({
      apiVersion: 'v1',
      profiles: [
        {
          name: 'personal',
          installationUrl: 'https://personal.example',
          workspaceId: 'personal-space',
          allowInsecureLoopback: false,
          credential: { type: 'environment', variable: 'SHELF_PERSONAL_TOKEN' },
        },
        {
          name: 'work',
          installationUrl: 'https://work.example',
          workspaceId: 'work-space',
          allowInsecureLoopback: false,
          credential: { type: 'environment', variable: 'SHELF_WORK_TOKEN' },
        },
      ],
    });
    expect(stdout.join('')).not.toMatch(/personal_secret|work_secret/u);
  });

  it('stores a token in the native keyring without persisting it or silently falling back', async () => {
    const configDirectory = await temporaryDirectory();
    const secret = 'keyring_secret_canary';
    const setPassword = vi.fn(async () => undefined);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'profiles',
        'set',
        'work',
        '--url',
        'https://work.shelf.example',
        '--workspace',
        'work-space',
        '--store-token-from-env',
        'SHELF_WORK_TOKEN',
      ],
      {
        env: { SHELF_CONFIG_DIR: configDirectory, SHELF_WORK_TOKEN: secret },
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
        keyring: {
          setPassword,
          getPassword: vi.fn(),
          deletePassword: vi.fn(),
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(setPassword).toHaveBeenCalledOnce();
    expect(setPassword).toHaveBeenCalledWith(
      'shelf-cli',
      expect.stringMatching(
        /^profile:work:[a-f0-9]{16}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      secret,
    );
    const output = JSON.parse(stdout[0] ?? '{}');
    expect(output).toMatchObject({
      profile: { name: 'work', credential: { type: 'keyring' } },
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(await readFile(join(configDirectory, 'profiles.json'), 'utf8')).not.toContain(secret);
  });

  it('resolves a keyring-backed profile for publishing without environment fallback', async () => {
    const configDirectory = await temporaryDirectory();
    const secret = 'native-keyring-publish-secret';
    let account = '';
    const keyring = {
      setPassword: vi.fn(async (_service: string, nextAccount: string) => {
        account = nextAccount;
      }),
      getPassword: vi.fn(async (_service: string, requestedAccount: string) => {
        expect(requestedAccount).toBe(account);
        return secret;
      }),
      deletePassword: vi.fn(async () => undefined),
    };
    const env = { SHELF_CONFIG_DIR: configDirectory, TOKEN_TO_STORE: secret };
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
          '--store-token-from-env',
          'TOKEN_TO_STORE',
        ],
        { env, keyring, stdout() {}, stderr() {} },
      ),
    ).toBe(0);

    const fileRoot = await temporaryDirectory();
    const file = join(fileRoot, 'idea.txt');
    await (await import('node:fs/promises')).writeFile(file, 'idea');
    const fetch = vi.fn(async () =>
      Response.json(
        {
          apiVersion: 'v1',
          kind: 'file',
          workspaceId: 'personal',
          artifactId: 'art_0123456789abcdefghijkl',
          revisionId: 'rev_0123456789abcdefghijkl',
          contentHash: `sha256:${'a'.repeat(64)}`,
          byteCount: 4,
          fileCount: 1,
          provenance: {
            classification: 'direct-publish',
            observed: { actorId: 'actor-agent', operation: 'file.publish' },
          },
          publisherMetadata: {},
          requestId: 'request-keyring',
          paths: {
            artifact: '/api/v1/artifacts/art_0123456789abcdefghijkl',
            revision: '/api/v1/revisions/rev_0123456789abcdefghijkl',
            content: '/api/v1/revisions/rev_0123456789abcdefghijkl/content',
          },
          replayed: false,
        },
        { status: 201 },
      ),
    );
    const exit = await runCli(['node', 'shelf', 'publish', file], {
      env: { SHELF_CONFIG_DIR: configDirectory },
      keyring,
      fetch,
      stdout() {},
      stderr() {},
    });

    expect(exit).toBe(0);
    expect(keyring.getPassword).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${secret}`,
    );
  });

  it('shows and explicitly removes one profile without mutating others accidentally', async () => {
    const configDirectory = await temporaryDirectory();
    const env = { SHELF_CONFIG_DIR: configDirectory };
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

    const shown: string[] = [];
    expect(
      await runCli(['node', 'shelf', 'profiles', 'show', 'default'], {
        env,
        stdout: (chunk) => shown.push(chunk),
        stderr() {},
      }),
    ).toBe(0);
    expect(JSON.parse(shown[0] ?? '{}')).toMatchObject({
      profile: { name: 'default', workspaceId: 'personal' },
    });

    expect(
      await runCli(['node', 'shelf', 'profiles', 'remove', 'default'], {
        env,
        stdout() {},
        stderr() {},
      }),
    ).toBe(2);
    const stillPresent: string[] = [];
    await runCli(['node', 'shelf', 'profiles', 'list'], {
      env,
      stdout: (chunk) => stillPresent.push(chunk),
      stderr() {},
    });
    expect(JSON.parse(stillPresent[0] ?? '{}').profiles).toHaveLength(1);

    const removed: string[] = [];
    expect(
      await runCli(['node', 'shelf', 'profiles', 'remove', 'default', '--yes'], {
        env,
        stdout: (chunk) => removed.push(chunk),
        stderr() {},
      }),
    ).toBe(0);
    expect(JSON.parse(removed[0] ?? '{}')).toEqual({
      apiVersion: 'v1',
      removed: { name: 'default' },
    });
  });
});
