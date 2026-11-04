import { describe, expect, it } from 'vitest';
import { addShareBoot, addSharePreloads } from '../src/web-app.js';

describe('share document preloads', () => {
  const html = '<html><head></head><body></body></html>';
  it('adds viewer chunks and their static dependencies', () => {
    const result = addSharePreloads(html, {
      'index.html': { file: 'assets/entry.js', imports: ['_entry-dep.js'] },
      '_entry-dep.js': { file: 'assets/entry-dep.js' },
      'src/viewer-loader.ts': {
        file: 'assets/loader-a.js',
        imports: ['_shared.js', 'index.html', '_entry-dep.js'],
      },
      'src/viewer-page.tsx': { file: 'assets/page-b.js', css: ['assets/page-c.css'] },
      '_shared.js': {
        file: 'assets/shared-d.js',
        imports: ['_nested.js'],
        dynamicImports: ['_dynamic.js'],
      },
      '_nested.js': { file: 'assets/nested.js' },
      '_dynamic.js': { file: 'assets/dynamic.js' },
    });
    expect(result).toContain('rel="modulepreload" href="/assets/loader-a.js"');
    expect(result).toContain('rel="modulepreload" href="/assets/page-b.js"');
    expect(result).toContain('rel="modulepreload" href="/assets/shared-d.js"');
    expect(result).toContain('rel="preload" as="style" href="/assets/page-c.css"');
    expect(result).not.toMatch(/entry\.js|entry-dep|nested|dynamic/);
  });
  it('leaves the document intact without a manifest', () => {
    expect(addSharePreloads(html, null)).toBe(html);
  });
});

describe('share document boot', () => {
  const html =
    '<html><head><script type="module" src="/assets/index-a.js"></script></head><body></body></html>';

  it('runs the prefetch script before the main bundle and names the renderer', () => {
    const result = addShareBoot(html, {
      prefetchFile: 'assets/share-prefetch-Ab12-_cd.js',
      rendererOrigin: 'https://render.example',
    });
    expect(result.indexOf('share-prefetch-Ab12-_cd.js')).toBeLessThan(result.indexOf('index-a.js'));
    expect(result).toContain(
      '<meta name="shelf-renderer-origin" content="https://render.example">',
    );
    expect(result).toContain('<link rel="preconnect" href="https://render.example" crossorigin>');
  });

  it('marks a missing renderer and ignores an unexpected prefetch path', () => {
    const result = addShareBoot(html, { prefetchFile: '../evil.js' });
    expect(result).toContain('<meta name="shelf-renderer-origin" content="">');
    expect(result).not.toContain('evil');
    expect(result).not.toContain('preconnect');
  });

  it('escapes the renderer origin', () => {
    expect(addShareBoot(html, { rendererOrigin: 'https://a.example/"><script>' })).not.toContain(
      '"><script>',
    );
  });
});
