import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerWebApp } from '../src/web-app.js';

const html = '<!doctype html><html><head><title>Shelf</title></head><body></body></html>';
const manifest = {
  'index.html': { file: 'assets/entry.js' },
  'src/viewer-loader.ts': { file: 'assets/loader.js', imports: ['_shared.js'] },
  'src/viewer-page.tsx': { file: 'assets/page.js' },
  '_shared.js': { file: 'assets/shared.js' },
};

describe('share document preload routes', () => {
  it.each([
    ['valid', JSON.stringify(manifest)],
    ['missing', undefined],
    ['invalid JSON', '{'],
    ['invalid shape', JSON.stringify({ 'src/viewer-loader.ts': { file: 7 } })],
    ['null', 'null'],
    ['array', '[]'],
  ])('serves the share document with a %s manifest', async (kind, contents) => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-share-preloads-'));
    const app = Fastify();
    const warn = vi.spyOn(app.log, 'warn');
    try {
      await mkdir(join(root, 'assets'));
      await writeFile(join(root, 'index.html'), html);
      await writeFile(join(root, 'favicon.svg'), '<svg></svg>');
      if (contents !== undefined) {
        await mkdir(join(root, '.vite'));
        await writeFile(join(root, '.vite/manifest.json'), contents);
      }
      await registerWebApp(app, { root });
      for (let request = 0; request < 2; request += 1) {
        const response = await app.inject({ method: 'GET', url: '/s/shr_test' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        if (kind === 'valid') {
          for (const file of ['loader', 'page', 'shared'])
            expect(response.body).toContain(`rel="modulepreload" href="/assets/${file}.js"`);
          expect(response.body).not.toContain('href="/assets/entry.js"');
        } else {
          expect(response.body).toBe(html);
        }
      }
      expect(warn).toHaveBeenCalledTimes(kind === 'valid' ? 0 : 1);
      expect((await app.inject({ method: 'GET', url: '/app' })).body).toBe(html);
    } finally {
      warn.mockRestore();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
