import { createHtmlPreviewSettingsService, type HtmlPreviewSettingsRepository } from '@shelf/core';
import { createRendererApp } from '@shelf/renderer';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShelfApp } from '../src/app.js';
import type { AuthenticationContext } from '../src/authenticate.js';
import { createDashboardHtmlPreviewSettings } from '../src/html-preview-settings.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const owner = {
  installationId: 'installation-main',
  actorId: 'owner',
  authenticationMethod: 'human-session' as const,
};
const route = '/api/v1/dashboard/settings/html-preview';

async function fixture(identity: AuthenticationContext | null = owner) {
  let stored: unknown | undefined;
  const repository: HtmlPreviewSettingsRepository = {
    findTrustedResourceOrigins: vi.fn(async () => stored),
    saveTrustedResourceOrigins: vi.fn(async (_installation, values) => {
      stored = [...values];
    }),
  };
  const settings = createHtmlPreviewSettingsService({
    installationId: owner.installationId,
    appOrigin: 'https://shelf.example',
    rendererOrigin: 'https://render.example',
    repository,
    defaultTrustedResourceOrigins: ['https://fallback.example'],
  });
  const dashboardSettings = createDashboardHtmlPreviewSettings({
    installationId: owner.installationId,
    appOrigin: 'https://shelf.example',
    settings,
    owners: { findHumanOwnerByInstallationId: async () => owner },
  });
  const app = await createShelfApp({
    stagingRoot: '/tmp/shelf-settings-test',
    authenticator: { authenticate: async () => identity ?? undefined },
    authorizer: { async authorize() {} },
    htmlPreviewSettings: dashboardSettings,
  });
  const renderer = await createRendererApp({
    appOrigin: 'https://shelf.example',
    trustedResourceOrigins: ['https://fallback.example'],
    readTrustedResourceOrigins: settings.read,
    resolver: {
      resolveHtml: async () => ({ status: 'available', html: '<h1>Private artifact</h1>' }),
    },
  });
  apps.push(app, renderer);
  const save = (values: unknown, origin: string | undefined = 'https://shelf.example') =>
    app.inject({
      method: 'PUT',
      url: route,
      ...(origin === undefined ? {} : { headers: { origin } }),
      payload: { trustedResourceOrigins: values },
    });
  const render = (protectedShare = false) =>
    renderer.inject({
      method: 'POST',
      url: '/render',
      headers: {
        origin: 'null',
        host: 'render.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        nonce: 'n'.repeat(22),
        ...(protectedShare
          ? { shareId: `shr_${'s'.repeat(22)}`, viewerToken: 't'.repeat(32) }
          : { publicCode: 'p'.repeat(12) }),
      }).toString(),
    });
  return {
    app,
    renderer,
    repository,
    settings,
    dashboardSettings,
    save,
    render,
    corrupt: (value: unknown) => {
      stored = value;
    },
  };
}

describe('owner HTML preview settings', () => {
  it('uses deployment defaults until saved, then applies changes and explicit clearing without restart', async () => {
    const { app, save, render, repository } = await fixture();
    expect((await app.inject({ url: route })).json()).toEqual({
      apiVersion: 'v1',
      trustedResourceOrigins: ['https://fallback.example'],
    });
    expect((await render()).headers['content-security-policy']).toContain(
      'https://fallback.example',
    );
    const saved = await save(['https://CDN.example:443/', 'https://cdn.example']);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      apiVersion: 'v1',
      trustedResourceOrigins: ['https://cdn.example'],
    });
    expect(repository.saveTrustedResourceOrigins).toHaveBeenCalledWith('installation-main', [
      'https://cdn.example',
    ]);
    for (const protectedShare of [false, true]) {
      const response = await render(protectedShare);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-security-policy']).toContain(
        "script-src 'unsafe-inline' data: https://cdn.example",
      );
      expect(response.headers['content-security-policy']).not.toContain('fallback.example');
      expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
      expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
      expect(response.headers['content-security-policy']).not.toContain('allow-same-origin');
    }
    expect((await save([])).statusCode).toBe(200);
    const cleared = await render();
    expect(cleared.statusCode).toBe(200);
    expect(cleared.headers['content-security-policy']).not.toMatch(
      /cdn\.example|fallback\.example/u,
    );
    const loaded = await app.inject({ url: route });
    expect(loaded.headers['cache-control']).toBe('no-store');
    expect(loaded.json().trustedResourceOrigins).toEqual([]);
  });

  it.each([
    ['anonymous', undefined, 401],
    ['agent', { ...owner, authenticationMethod: 'access-credential' as const }, 403],
    ['workspace human', { ...owner, actorId: 'limited-human' }, 403],
    ['other installation', { ...owner, installationId: 'other' }, 403],
  ])('rejects %s for reads and writes', async (_label, identity, status) => {
    const target = await fixture(identity ?? null);
    expect((await target.app.inject({ url: route })).statusCode).toBe(status);
    expect((await target.save([])).statusCode).toBe(status);
    expect(target.repository.findTrustedResourceOrigins).not.toHaveBeenCalled();
    expect(target.repository.saveTrustedResourceOrigins).not.toHaveBeenCalled();
  });

  it('requires an Origin header for cookie-authenticated writes', async () => {
    const { app, repository } = await fixture();
    expect(
      (await app.inject({ method: 'PUT', url: route, payload: { trustedResourceOrigins: [] } }))
        .statusCode,
    ).toBe(403);
    expect(repository.saveTrustedResourceOrigins).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example', 'null', 'https://shelf.example.attacker.test'])(
    'rejects a cookie-authenticated write from %s',
    async (origin) => {
      const { save, repository } = await fixture();
      expect((await save(['https://cdn.example'], origin)).statusCode).toBe(403);
      expect(repository.saveTrustedResourceOrigins).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['https://shelf.example:8443'],
    ['https://SHELF.example.'],
    ['https://render.example:8443'],
    ['http://cdn.example'],
    ['https://cdn.example/script.js'],
    ['https://*.example'],
    ["'self'"],
    ['https://user:password@cdn.example'],
    ['https://cdn.example?query'],
    ['https://cdn.example#hash'],
    ['https://cdn.example;connect-src'],
    Array.from({ length: 33 }, (_, i) => `https://cdn${i}.example`),
    [`https://${'a'.repeat(2048)}.example`],
  ])('rejects invalid sources %j without changing stored settings', async (...values) => {
    const { save, repository } = await fixture();
    expect((await save(values)).statusCode).toBe(400);
    expect(repository.saveTrustedResourceOrigins).not.toHaveBeenCalled();
  });

  it('does not restore environment permissions on storage failure or invalid stored data', async () => {
    const { app, render, repository, corrupt, save } = await fixture();
    for (const value of [null, {}, ['https://shelf.example'], ['https://cdn.example/path']]) {
      corrupt(value);
      expect((await app.inject({ url: route })).statusCode).toBe(503);
      const response = await render();
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('Private artifact');
      expect(response.headers['content-security-policy']).not.toContain('fallback.example');
    }
    vi.mocked(repository.findTrustedResourceOrigins).mockRejectedValue(
      new Error('database canary'),
    );
    expect((await app.inject({ url: route })).statusCode).toBe(503);
    expect((await render()).statusCode).toBe(503);
    vi.mocked(repository.saveTrustedResourceOrigins).mockRejectedValue(
      new Error('database canary'),
    );
    const failed = await save([]);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain('database canary');
  });

  it('checks the current owner instead of inferring authority from workspace grants', async () => {
    const { dashboardSettings } = await fixture();
    expect(await dashboardSettings.isOwner(owner)).toBe(true);
    expect(await dashboardSettings.isOwner({ ...owner, actorId: 'limited-human' })).toBe(false);
  });
});
