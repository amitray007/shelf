import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareLocalFolder } from '../src/commands/folders.js';
import { checkFolderSite, type FolderSiteWarning } from '../src/folder-site-check.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function check(files: Record<string, string>): Promise<FolderSiteWarning[]> {
  const parent = await mkdtemp(join(tmpdir(), 'shelf-site-check-'));
  roots.push(parent);
  const root = join(parent, 'site');
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return checkFolderSite(await prepareLocalFolder(root));
}

function summary(warnings: readonly FolderSiteWarning[]): string[] {
  return warnings.map((w) => `${w.code} ${w.path} ${w.reference}`.trimEnd());
}

describe('checkFolderSite', () => {
  it('returns nothing for a clean static folder', async () => {
    const warnings = await check({
      'index.html':
        '<link rel="stylesheet" href="style.css"><script type="module" src="./app.js"></script><a href="docs/">Docs</a><img src="img/a.png">',
      'style.css': "@import 'base.css'; body { background: url(img/a.png) }",
      'base.css': '',
      'app.js': "import { x } from './lib.js'; export * from './docs/../lib.js';",
      'lib.js': 'export const x = 1;',
      'img/a.png': 'x',
      'docs/index.html': '<p>docs</p>',
    });
    expect(warnings).toEqual([]);
  });

  it('flags root-relative references in HTML, CSS and JS', async () => {
    const warnings = await check({
      'index.html': '<script src="/assets/app.js"></script><a href="/about">About</a>',
      'style.css': 'a { background: url("/img/a.png") }',
      'app.js': "import '/lib.js';",
    });
    expect(summary(warnings)).toEqual([
      'ROOT_RELATIVE_REFERENCE app.js /lib.js',
      'ROOT_RELATIVE_REFERENCE index.html /about',
      'ROOT_RELATIVE_REFERENCE index.html /assets/app.js',
      'ROOT_RELATIVE_REFERENCE style.css /img/a.png',
    ]);
    expect(warnings[0]?.message).toContain('relative path');
    expect(warnings.find((w) => w.reference === '/assets/app.js')?.message).toContain(
      'Use the relative path assets/app.js;',
    );
  });

  it('suggests the relative path from a nested file', async () => {
    const warnings = await check({
      'assets/index.css': 'body { background: url(/assets/bg.png) }',
    });
    expect(warnings[0]?.message).toContain('Use the relative path bg.png;');
    expect(warnings[0]?.message).toContain("base: './'");
  });

  it('flags external subresources but not external navigation links', async () => {
    const warnings = await check({
      'index.html': `<a href="https://example.com/x">x</a><area href="//example.com/y">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
<link rel="preconnect" href="https://fonts.gstatic.com">
<script src="//cdn.example.com/lib.js"></script>
<img srcset="a.png 1x, https://cdn.example.com/b.png 2x" src="a.png">
<style>@import url(https://example.com/a.css); .x { background: url(https://example.com/i.png) }</style>
<div style="background: url('https://example.com/s.png')"></div>`,
      'index.css': '',
      'a.png': 'x',
      'app.mjs': "import('https://esm.sh/x'); import 'https://esm.sh/y';",
    });
    expect(warnings.every((w) => w.code === 'EXTERNAL_REFERENCE')).toBe(true);
    const references = warnings.map((w) => w.reference);
    expect(references).toEqual(
      expect.arrayContaining([
        'https://fonts.googleapis.com/css2?family=Inter',
        '//cdn.example.com/lib.js',
        'https://cdn.example.com/b.png',
        'https://example.com/a.css',
        'https://example.com/i.png',
        'https://example.com/s.png',
        'https://esm.sh/x',
        'https://esm.sh/y',
      ]),
    );
    expect(references).not.toContain('https://example.com/x');
    expect(references).not.toContain('//example.com/y');
    expect(references).not.toContain('https://fonts.gstatic.com');
  });

  it('flags bare module specifiers in JS files and inline module scripts', async () => {
    const warnings = await check({
      'index.html':
        '<script type="module">import * as THREE from "three"; import "./app.js";</script><script>import("classic")</script>',
      'app.js': "import { a } from 'lodash'; export { b } from \"rxjs/operators\"; import('vue');",
    });
    expect(summary(warnings)).toEqual([
      'BARE_MODULE_SPECIFIER app.js lodash',
      'BARE_MODULE_SPECIFIER app.js rxjs/operators',
      'BARE_MODULE_SPECIFIER app.js vue',
      'BARE_MODULE_SPECIFIER index.html three',
    ]);
  });

  it('accepts bare specifiers resolved by a local import map and checks its targets', async () => {
    const warnings = await check({
      'index.html':
        '<script type="importmap">{"imports":{"three":"./vendor/three.module.js","three/addons/":"./vendor/addons/","cdn-lib":"https://cdn.example/lib.js"}}</script><script type="module" src="app.js"></script>',
      'app.js':
        "import * as THREE from 'three'; import { Orbit } from 'three/addons/orbit.js'; import 'cdn-lib'; import 'unmapped';",
      'vendor/three.module.js': '',
      'vendor/addons/orbit.js': '',
    });
    expect(summary(warnings)).toEqual([
      'BARE_MODULE_SPECIFIER app.js unmapped',
      'EXTERNAL_REFERENCE index.html https://cdn.example/lib.js',
    ]);
  });

  it('flags a directory link without a trailing slash', async () => {
    const warnings = await check({
      'index.html': '<a href="docs">Docs</a><a href="docs/">Docs</a>',
      'docs/index.html': '',
    });
    expect(summary(warnings)).toEqual(['DIRECTORY_REFERENCE index.html docs']);
    expect(warnings[0]?.message).toContain('docs/');
  });

  it('flags source files browsers cannot run', async () => {
    const warnings = await check({
      'index.html':
        '<script type="module" src="src/main.ts"></script><script src="a.tsx"></script><script src="b.jsx"></script><script src="c.vue"></script><script src="d.svelte"></script>',
      'app.js': "import './x.ts';",
    });
    expect(summary(warnings)).toEqual([
      'UNBUILT_SOURCE app.js ./x.ts',
      'UNBUILT_SOURCE index.html a.tsx',
      'UNBUILT_SOURCE index.html b.jsx',
      'UNBUILT_SOURCE index.html c.vue',
      'UNBUILT_SOURCE index.html d.svelte',
      'UNBUILT_SOURCE index.html src/main.ts',
    ]);
  });

  it('flags missing relative references from every scanned file type', async () => {
    const warnings = await check({
      'index.html':
        '<img src="nope.png"><video poster="poster.jpg"><source src="v.mp4"></video><a href="missing.html">x</a>',
      'style.css': '@import "gone.css"; a { background: url(gone.png) }',
      'app.js': "import './gone.js';",
    });
    expect(summary(warnings)).toEqual([
      'MISSING_REFERENCE app.js ./gone.js',
      'MISSING_REFERENCE index.html missing.html',
      'MISSING_REFERENCE index.html nope.png',
      'MISSING_REFERENCE index.html poster.jpg',
      'MISSING_REFERENCE index.html v.mp4',
      'MISSING_REFERENCE style.css gone.css',
      'MISSING_REFERENCE style.css gone.png',
    ]);
  });

  it('reports a missing root index at folder level first', async () => {
    const warnings = await check({ 'page.html': '<a href="/x">x</a>' });
    expect(summary(warnings)).toEqual(['NO_ROOT_INDEX', 'ROOT_RELATIVE_REFERENCE page.html /x']);
    expect(warnings[0]).toMatchObject({ path: '', reference: '' });
    expect(await check({ 'index.html': '', 'notes.md': '' })).toEqual([]);
    expect(await check({ 'readme.md': '# hi' })).toEqual([]);
  });

  it('ignores empty, fragment, and non-network schemes', async () => {
    const warnings = await check({
      'index.html': `<img src=""><a href="#top">t</a><img src="data:image/png;base64,AAAA">
<img src="blob:https://x/1"><a href="mailto:a@b.c">m</a><a href="tel:123">t</a>
<a href="javascript:void(0)">j</a><iframe src="about:blank"></iframe>
<style>a { background: url(data:image/svg+xml;base64,AAAA); fill: url(#grad) }</style>`,
    });
    expect(warnings).toEqual([]);
  });

  it('strips query and fragment, percent-decodes, and resolves directory indexes', async () => {
    const warnings = await check({
      'index.html':
        '<img src="img/my%20pic.png?v=2#x"><a href="docs/">d</a><a href="docs/?q=1">d</a><a href="./">r</a><a href="docs/guide/index.html#a">g</a>',
      'img/my pic.png': 'x',
      'docs/index.html': '<a href="../">home</a><a href="guide/">g</a>',
      'docs/guide/index.html': '<a href="../../index.html">up</a>',
    });
    expect(warnings).toEqual([]);
  });

  it('resolves relative to the referencing file and treats escaping the root as missing', async () => {
    const warnings = await check({
      'index.html': '<script src="../outside.js"></script><img src="../../x.png">',
      'sub/page.html': '<img src="a.png"><img src="../a.png"><img src="../../a.png">',
      'sub/a.png': 'x',
    });
    expect(summary(warnings)).toEqual([
      'MISSING_REFERENCE index.html ../../x.png',
      'MISSING_REFERENCE index.html ../outside.js',
      'MISSING_REFERENCE sub/page.html ../../a.png',
      'MISSING_REFERENCE sub/page.html ../a.png',
    ]);
  });

  it('deduplicates identical warnings', async () => {
    const warnings = await check({
      'index.html': '<img src="/a.png"><img src="/a.png"><img src="/a.png">',
    });
    expect(warnings).toHaveLength(1);
  });

  it('caps warnings at 32 in deterministic order', async () => {
    const images = Array.from(
      { length: 40 },
      (_, i) => `<img src="/img-${String(i).padStart(2, '0')}.png">`,
    );
    const warnings = await check({ 'index.html': images.join('') });
    expect(warnings).toHaveLength(32);
    expect(warnings[0]?.reference).toBe('/img-00.png');
    expect(warnings[31]?.reference).toBe('/img-31.png');
  });

  it('skips files over 2 MiB', async () => {
    const big = `${'a'.repeat(2 * 1024 * 1024)}<img src="/x.png">`;
    expect(await check({ 'index.html': big })).toEqual([]);
  });
});
