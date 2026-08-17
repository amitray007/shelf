import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadShelfServerConfig } from '../src/server-config.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgresql://shelf@postgres/shelf',
    SHELF_STORAGE_DRIVER: 'local',
    SHELF_STORAGE_LOCAL_ROOT: '/var/lib/shelf/content',
    SHELF_INSTALLATION_ID: 'installation-main',
    SHELF_AUTH_BASE_URL: 'https://shelf.example.test',
    SHELF_AUTH_SECRET: 'a'.repeat(32),
    SHELF_SHARE_SIGNING_KEY: 's'.repeat(32),
    ...overrides,
  };
}

describe('loadShelfServerConfig', () => {
  it('loads explicit production settings with conservative bind defaults', async () => {
    await expect(loadShelfServerConfig(environment())).resolves.toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      installationId: 'installation-main',
      auth: { baseUrl: 'https://shelf.example.test', secret: 'a'.repeat(32) },
      share: { signingKey: 's'.repeat(32) },
      persistence: {
        postgres: { connectionString: 'postgresql://shelf@postgres/shelf' },
        content: { driver: 'local', root: '/var/lib/shelf/content' },
      },
    });
  });

  it('loads a validated runtime web root and renderer public origin', async () => {
    await expect(
      loadShelfServerConfig(
        environment({
          SHELF_WEB_ROOT: '/opt/shelf/web',
          SHELF_RENDERER_PUBLIC_ORIGIN: 'https://renderer.shelf.example.test',
        }),
      ),
    ).resolves.toMatchObject({
      webRoot: '/opt/shelf/web',
      rendererPublicOrigin: 'https://renderer.shelf.example.test',
    });
  });

  it('reads the auth secret from a file and trims only its trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-config-'));
    temporaryRoots.push(root);
    const secretFile = join(root, 'auth-secret');
    await writeFile(secretFile, `${'b'.repeat(32)}\n`, { mode: 0o600 });

    const config = await loadShelfServerConfig(
      environment({ SHELF_AUTH_SECRET: undefined, SHELF_AUTH_SECRET_FILE: secretFile }),
    );
    expect(config.auth.secret).toBe('b'.repeat(32));
  });

  it('loads the share signing key independently from a protected file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-config-'));
    temporaryRoots.push(root);
    const keyFile = join(root, 'share-signing-key');
    await writeFile(keyFile, `${'k'.repeat(32)}\n`, { mode: 0o600 });

    const config = await loadShelfServerConfig(
      environment({
        SHELF_SHARE_SIGNING_KEY: undefined,
        SHELF_SHARE_SIGNING_KEY_FILE: keyFile,
      }),
    );
    expect(config.share.signingKey).toBe('k'.repeat(32));
    expect(config.share.signingKey).not.toBe(config.auth.secret);
  });

  it('accepts loopback HTTP on IPv6', async () => {
    const config = await loadShelfServerConfig(
      environment({ SHELF_AUTH_BASE_URL: 'http://[::1]:3000' }),
    );
    expect(config.auth.baseUrl).toBe('http://[::1]:3000');
  });

  it('rejects contradictory secret sources without echoing either value', async () => {
    const secret = 'secret-canary-that-must-never-be-printed';
    await expect(
      loadShelfServerConfig(
        environment({ SHELF_AUTH_SECRET: secret, SHELF_AUTH_SECRET_FILE: secret }),
      ),
    ).rejects.toThrow('exactly one');
    try {
      await loadShelfServerConfig(
        environment({ SHELF_AUTH_SECRET: secret, SHELF_AUTH_SECRET_FILE: secret }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('requires exactly one independent share signing key source without echoing it', async () => {
    const key = 'share-key-canary-that-must-never-be-printed';
    const invalidEnvironment = environment({
      SHELF_SHARE_SIGNING_KEY: key,
      SHELF_SHARE_SIGNING_KEY_FILE: key,
    });

    await expect(loadShelfServerConfig(invalidEnvironment)).rejects.toThrow('exactly one');
    try {
      await loadShelfServerConfig(invalidEnvironment);
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });

  it.each([
    ['invalid installation id', { SHELF_INSTALLATION_ID: '../unsafe' }],
    ['invalid port', { SHELF_PORT: '70000' }],
    ['public plain HTTP auth URL', { SHELF_AUTH_BASE_URL: 'http://shelf.example.test' }],
    ['empty host', { SHELF_HOST: '' }],
    ['auth URL path', { SHELF_AUTH_BASE_URL: 'https://shelf.example.test/unsafe' }],
    ['renderer URL path', { SHELF_RENDERER_PUBLIC_ORIGIN: 'https://renderer.example/path' }],
    [
      'renderer hostname shared with Shelf',
      { SHELF_RENDERER_PUBLIC_ORIGIN: 'https://shelf.example.test:3001' },
    ],
    ['empty web root', { SHELF_WEB_ROOT: '' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(loadShelfServerConfig(environment(overrides))).rejects.toBeInstanceOf(Error);
  });
});
