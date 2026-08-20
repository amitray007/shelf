import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerWebApp } from '../src/web-app.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production web application boundary', () => {
  it('serves share routes and immutable assets with a renderer-bounded document policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-web-root-'));
    roots.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>shelf</title>');
    await writeFile(join(root, 'assets', 'app.js'), 'export {};');
    const app = Fastify();
    apps.push(app);
    await registerWebApp(app, {
      root,
      rendererOrigin: 'https://renderer.shelf.example',
    });
    await app.ready();

    const document = await app.inject({ method: 'GET', url: '/s/shr_test' });
    const dashboard = await app.inject({
      method: 'GET',
      url: '/app/w/workspace-main/artifacts/art_test',
    });
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    const unknownApi = await app.inject({ method: 'GET', url: '/api/v1/unknown' });

    expect(document.statusCode).toBe(200);
    expect(document.body).toContain('<title>shelf</title>');
    expect(document.headers['cache-control']).toBe('no-store');
    expect(document.headers['referrer-policy']).toBe('no-referrer');
    expect(document.headers['content-security-policy']).toContain(
      'frame-src https://renderer.shelf.example',
    );
    expect(document.headers['content-security-policy']).toContain(
      "form-action 'self' https://renderer.shelf.example",
    );
    expect(document.headers['content-security-policy']).toContain(
      "img-src 'self' https://api.dicebear.com data: blob:",
    );
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers['cache-control']).toBe('no-store');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers['content-type']).toContain('application/json');
  });
});
