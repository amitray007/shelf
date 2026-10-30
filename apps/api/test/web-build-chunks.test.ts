import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { addSharePreloads } from '../src/web-app.js';

interface Chunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  isDynamicEntry?: boolean;
}

const webRoot = new URL('../../web/dist/', import.meta.url);
const manifestPath = new URL('.vite/manifest.json', webRoot);
const shareRoots = ['index.html', 'src/viewer-loader.ts', 'src/viewer-page.tsx'];

// Inspect an existing production build; never add a build to the normal test run.
describe.skipIf(!existsSync(manifestPath))('production web chunk boundaries', () => {
  const manifest: Record<string, Chunk> = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {};

  function graph(roots: string[], includeDynamic = false): Set<string> {
    const seen = new Set<string>();
    function visit(key: string): void {
      if (seen.has(key)) return;
      seen.add(key);
      expect(manifest[key], key).toBeDefined();
      for (const dependency of manifest[key]?.imports ?? []) visit(dependency);
      if (includeDynamic)
        for (const dependency of manifest[key]?.dynamicImports ?? []) visit(dependency);
    }
    for (const key of roots) visit(key);
    return seen;
  }

  it('bounds share and dashboard startup requests and bytes', () => {
    const cases = [
      [shareRoots, 20, 1_000_000],
      [
        [
          'index.html',
          'src/dashboard/layout.tsx',
          'src/dashboard/routes.ts',
          'src/dashboard/artifacts-page.tsx',
        ],
        24,
        1_050_000,
      ],
    ] as const;
    expect(graph(['index.html']).size).toBeLessThanOrEqual(3);
    for (const [roots, maxRequests, maxBytes] of cases) {
      const chunks = [...graph([...roots])].map((key) => manifest[key]);
      expect(chunks.length).toBeLessThanOrEqual(maxRequests);
      const bytes = chunks.reduce(
        (sum, chunk) => sum + statSync(new URL(chunk.file, webRoot)).size,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('keeps feature renderers and parsers behind dynamic imports', () => {
    const startup = graph(shareRoots);
    const reachable = graph(shareRoots, true);
    const features = [
      'src/components/markdown-view.tsx',
      'src/components/folder-browser.tsx',
      'src/components/preview/pdf-preview.tsx',
      'src/components/preview/office-document-preview.tsx',
      'src/components/preview/delimited-table-preview.tsx',
      'src/components/preview/structured-data-preview.tsx',
      'src/components/preview/media-preview.tsx',
      ...Object.keys(manifest).filter((key) =>
        /node_modules\/(?:@pierre|@shikijs|shiki|docx-preview|read-excel-file)\//.test(key),
      ),
    ];
    for (const key of features) {
      expect(manifest[key]?.isDynamicEntry, key).toBe(true);
      expect(reachable.has(key), key).toBe(true);
      expect(startup.has(key), key).toBe(false);
    }
  });

  it('generates valid share preloads with the grouped chunk names', () => {
    const document = addSharePreloads('<html><head></head></html>', manifest);
    const files = [...document.matchAll(/rel="modulepreload" href="\/([^"]+)"/g)].map(
      (match) => match[1],
    );
    const startupFiles = new Set([...graph(shareRoots)].map((key) => manifest[key].file));
    expect(files.length).toBeGreaterThan(2);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(startupFiles.has(file), file).toBe(true);
      expect(existsSync(new URL(file, webRoot)), file).toBe(true);
    }
    const initialFiles = new Set([...graph(['index.html'])].map((key) => manifest[key].file));
    for (const key of shareRoots.slice(1)) {
      for (const dependency of [key, ...(manifest[key]?.imports ?? [])]) {
        const file = manifest[dependency]?.file;
        if (!initialFiles.has(file)) expect(files).toContain(file);
      }
    }
    const groups = [...startupFiles].filter((file) => /^assets\/(icons|ui)-/.test(file));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const file of groups) expect(file).toMatch(/^assets\/[\w.-]+\.js$/);
  });
});
