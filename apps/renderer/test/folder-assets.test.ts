import { describe, expect, it, vi } from 'vitest';

import { inlineFolderAssetSources } from '../src/folder-assets.js';

const appOrigin = 'https://shelf.example';
const publicCode = 'AbCdEf0123_-';
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
const mp4Bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18]);

function imageAsset() {
  return {
    mediaType: 'image/png',
    byteCount: pngBytes.byteLength,
    async read() {
      return (async function* content() {
        yield pngBytes;
      })();
    },
  };
}

describe('folder HTML asset embedding', () => {
  it('embeds repeated exact Public image URLs from the same revision with one content read', async () => {
    const source = `${appOrigin}/api/v1/public/links/${publicCode}/tree/content/preview?path=images%2Flogo.png`;
    const readAsset = vi.fn(async () => imageAsset());

    const html = await inlineFolderAssetSources({
      html: `<!doctype html><img src="${source}"><img src="${source}">`,
      htmlPath: 'index.html',
      appOrigin,
      publicCode,
      maximumOutputBytes: 4_096,
      readAsset,
    });

    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(readAsset).toHaveBeenCalledWith('images/logo.png');
    expect(html.match(/iVBORw==/gu)).toHaveLength(1);
    expect(html.match(/data-shelf-embedded-src="0"/gu)).toHaveLength(2);
    expect(html).toContain('new Map([["0",["image/png","iVBORw=="]]])');
    expect(html).toContain('URL.createObjectURL(new Blob');
    expect(html).not.toContain(source);

    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(script).toBeDefined();
    let observerCallback: ((records: Array<{ addedNodes: unknown[] }>) => void) | undefined;
    class MutationObserverStub {
      constructor(callback: typeof observerCallback) {
        observerCallback = callback;
      }
      observe() {}
      disconnect() {}
    }
    const setAttribute = vi.fn();
    const removeAttribute = vi.fn();
    const element = {
      nodeType: 1,
      matches: () => true,
      querySelectorAll: () => [],
      getAttribute: (name: string) => (name === 'data-shelf-embedded-src' ? '0' : null),
      setAttribute,
      removeAttribute,
    };
    const createObjectURL = vi.fn(() => 'blob:null/embedded-image');
    Function(
      'MutationObserver',
      'document',
      'addEventListener',
      'URL',
      'Blob',
      script ?? '',
    )(
      MutationObserverStub,
      {},
      () => undefined,
      { createObjectURL, revokeObjectURL: () => undefined },
      Blob,
    );
    observerCallback?.([{ addedNodes: [element] }]);

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(setAttribute).toHaveBeenCalledWith('src', 'blob:null/embedded-image');
    expect(removeAttribute).toHaveBeenCalledWith('data-shelf-embedded-src');
  });

  it('resolves relative image paths against the HTML entry for Protected shares', async () => {
    const readAsset = vi.fn(async () => imageAsset());

    const html = await inlineFolderAssetSources({
      html: '<!doctype html><img src="../images/logo.png">',
      htmlPath: 'site/pages/index.html',
      appOrigin,
      maximumOutputBytes: 4_096,
      readAsset,
    });

    expect(readAsset).toHaveBeenCalledWith('site/images/logo.png');
    expect(html).toContain('data-shelf-embedded-src="0"');
    expect(html).toContain('iVBORw==');
  });

  it('embeds a video poster and source from the same folder revision', async () => {
    const readAsset = vi.fn(async (path: string) => {
      const mediaType = path.endsWith('.mp4') ? 'video/mp4' : 'image/png';
      const bytes = path.endsWith('.mp4') ? mp4Bytes : pngBytes;
      return {
        mediaType,
        byteCount: bytes.byteLength,
        async read() {
          return (async function* content() {
            yield bytes;
          })();
        },
      };
    });

    const html = await inlineFolderAssetSources({
      html: [
        '<!doctype html><video controls preload="none" poster="02-lookup.png">',
        '<source src="btree-index-lesson.mp4" type="video/mp4">',
        '</video>',
      ].join(''),
      htmlPath: 'index.html',
      appOrigin,
      maximumOutputBytes: 4_096,
      readAsset,
    });

    expect(readAsset).toHaveBeenCalledTimes(2);
    expect(readAsset).toHaveBeenCalledWith('02-lookup.png');
    expect(readAsset).toHaveBeenCalledWith('btree-index-lesson.mp4');
    expect(html).toContain('data-shelf-embedded-poster="0"');
    expect(html).toContain('data-shelf-embedded-src="1"');
    expect(html).toContain('["image/png","iVBORw=="]');
    expect(html).toContain('["video/mp4","AAAAGA=="]');
    expect(html).not.toContain('poster="02-lookup.png"');
    expect(html).not.toContain('src="btree-index-lesson.mp4"');
  });

  it('does not resolve external, cross-share, or unsafe media references', async () => {
    const readAsset = vi.fn(async (path: string) =>
      path === 'notes.txt'
        ? {
            ...imageAsset(),
            mediaType: 'text/plain',
          }
        : imageAsset(),
    );
    const external = 'https://outside.example/logo.png';
    const otherShare = `${appOrigin}/api/v1/public/links/ZbCdEf0123_-/tree/content/preview?path=logo.png`;

    const html = await inlineFolderAssetSources({
      html: `<!doctype html><img src="${external}"><img src="${otherShare}"><img src="notes.txt"><video src="logo.png"></video>`,
      htmlPath: 'index.html',
      appOrigin,
      publicCode,
      maximumOutputBytes: 4_096,
      readAsset,
    });

    expect(readAsset).toHaveBeenCalledTimes(2);
    expect(readAsset).toHaveBeenCalledWith('notes.txt');
    expect(readAsset).toHaveBeenCalledWith('logo.png');
    expect(html).toContain(external);
    expect(html).toContain(otherShare);
    expect(html).toContain('notes.txt');
    expect(html).toContain('logo.png');
  });

  it('does not read an image when embedding it would exceed the response bound', async () => {
    const asset = imageAsset();
    const read = vi.spyOn(asset, 'read');

    const html = await inlineFolderAssetSources({
      html: '<!doctype html><img src="logo.png">',
      htmlPath: 'index.html',
      appOrigin,
      maximumOutputBytes: 32,
      readAsset: async () => asset,
    });

    expect(read).not.toHaveBeenCalled();
    expect(html).toContain('logo.png');
  });
});
