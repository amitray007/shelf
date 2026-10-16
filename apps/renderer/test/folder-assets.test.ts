import { describe, expect, it } from 'vitest';

import { folderSessionFileUrl, rewritePublicPreviewReferences } from '../src/folder-assets.js';

const appOrigin = 'https://shelf.example';
const publicCode = 'AbCdEf0123_-';
const sessionPath = '/f/token.signature/';

function previewUrl(path: string, origin = appOrigin, code = publicCode): string {
  return `${origin}/api/v1/public/links/${code}/tree/content/preview?path=${encodeURIComponent(path)}`;
}

describe('folder session URLs', () => {
  it('encodes each portable path segment under the session path', () => {
    expect(folderSessionFileUrl(sessionPath, 'assets/hero image#1.png')).toBe(
      '/f/token.signature/assets/hero%20image%231.png',
    );
  });
});

describe('Public preview reference compatibility', () => {
  it('points exact same-link preview URLs at the folder session', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" href="${previewUrl('css/site.css')}"></head><body><img src="${previewUrl('img/a b.png')}"><video poster="${previewUrl('img/poster.png')}"></video><template><img src="${previewUrl('img/t.png')}"></template></body></html>`;

    const rendered = rewritePublicPreviewReferences({ html, appOrigin, publicCode, sessionPath });

    expect(rendered).toContain('href="/f/token.signature/css/site.css"');
    expect(rendered).toContain('src="/f/token.signature/img/a%20b.png"');
    expect(rendered).toContain('poster="/f/token.signature/img/poster.png"');
    expect(rendered).toContain('src="/f/token.signature/img/t.png"');
    expect(rendered).not.toContain('/api/v1/public/links/');
  });

  it('leaves other origins, other links, extra parameters, and invalid paths unchanged', () => {
    const references = [
      previewUrl('a.png', 'https://other.example'),
      previewUrl('a.png', appOrigin, 'ZZZZZZZZZZZZ'),
      `${previewUrl('a.png')}&download=1`,
      `${previewUrl('a.png')}#fragment`,
      previewUrl('../escape.png'),
    ];
    const html = `<!doctype html><body>${references.map((src) => `<img src="${src}">`).join('')}<img src="${previewUrl('ok.png')}"></body>`;

    const rendered = rewritePublicPreviewReferences({ html, appOrigin, publicCode, sessionPath });

    for (const reference of references) {
      expect(rendered).toContain(reference.replaceAll('&', '&amp;'));
    }
    expect(rendered).toContain('src="/f/token.signature/ok.png"');
  });

  it('returns authored HTML bytes unchanged when no preview URL is present', () => {
    const html = '<!DOCTYPE html><p>Unparsed <b>markup';

    expect(rewritePublicPreviewReferences({ html, appOrigin, publicCode, sessionPath })).toBe(html);
  });
});
