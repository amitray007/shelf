import { expect, test } from '@playwright/test';

import { folderResolution, folderTreePage, htmlResolution, rendererOrigin } from './fixtures.js';

const cdn = 'https://trusted-cdn.example';
const pngDot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const library = `customElements.define('cdn-greeting', class extends HTMLElement {
  connectedCallback() { this.textContent = 'CDN component ready'; }
});
const probe = { origin: self.origin, parentDom: false, parentStorage: false, cookies: false };
try { parent.document.body.dataset.cdnLeak = 'true'; probe.parentDom = true; } catch {}
try { parent.localStorage.setItem('cdn-leak', 'true'); probe.parentStorage = true; } catch {}
try { document.cookie; probe.cookies = true; } catch {}
document.body.dataset.probe = JSON.stringify(probe);
Promise.all([
  fetch('https://trusted-cdn.example/collect').then(() => 'allowed', () => 'blocked'),
  fetch('http://127.0.0.1:43873/api/v1/renderer-canary', { credentials: 'include' }).then(() => 'allowed', () => 'blocked'),
]).then(results => { document.body.dataset.connections = results.join(','); });`;

for (const kind of ['file', 'folder'] as const) {
  test(
    kind === 'file'
      ? 'standalone preview loads trusted CDN assets while retaining isolation'
      : 'folder preview blocks CDN assets and cross-session redirects',
    async ({ page }) => {
      const publicCode = kind === 'file' ? 'CdnFile12345' : 'CdnFolder123';
      const prefix = `/api/v1/public/links/${publicCode}`;
      await page.route(`**${prefix}/resolve*`, (route) =>
        route.fulfill({
          json: {
            ...(kind === 'file' ? htmlResolution : folderResolution),
            accessType: 'public',
            publicCode,
            action:
              kind === 'file'
                ? { type: 'content', path: `${prefix}/content` }
                : { type: 'tree', path: `${prefix}/tree` },
          },
        }),
      );
      await page.route(new RegExp(`${prefix}/tree(?:[/?]|$)`), (route) => {
        if (new URL(route.request().url()).pathname.endsWith('/content')) {
          return route.fulfill({ contentType: 'text/html', body: '<h1>CDN preview</h1>' });
        }
        return route.fulfill({
          json: {
            ...folderTreePage,
            items: [
              {
                kind: 'file',
                path: 'index.html',
                mediaType: 'text/html',
                byteCount: 100,
                contentHash: `sha256:${'a'.repeat(64)}`,
              },
            ],
          },
        });
      });
      const requests: string[] = [];
      await page.route('https://trusted-cdn.example/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        const headers = { 'access-control-allow-origin': '*' };
        if (path === '/library.js')
          return route.fulfill({ headers, contentType: 'text/javascript', body: library });
        if (path === '/module.js')
          return route.fulfill({
            headers,
            contentType: 'text/javascript',
            body: "import('./chunk.js').then(m => { document.body.dataset.module = m.value; });",
          });
        if (path === '/chunk.js')
          return route.fulfill({
            headers,
            contentType: 'text/javascript',
            body: "export const value = 'ready';",
          });
        if (path === '/style.css')
          return route.fulfill({
            headers,
            contentType: 'text/css',
            body: 'cdn-greeting { color: rgb(1, 2, 3); }',
          });
        if (path === '/dot.png')
          return route.fulfill({ headers, contentType: 'image/png', body: pngDot });
        return route.fulfill({ status: 204, body: '' });
      });
      const prohibitedRequests: string[] = [];
      await page.route('https://untrusted-cdn.example/**', (route) => {
        prohibitedRequests.push(route.request().url());
        return route.fulfill({
          contentType: 'text/javascript',
          body: "document.body.dataset.untrusted = 'ran';",
        });
      });
      await page.route('**/api/v1/renderer-canary*', (route) => {
        prohibitedRequests.push(route.request().url());
        return route.fulfill({ json: { leaked: true } });
      });

      const mainResponse = await page.goto(`/s/${publicCode}`);
      expect(mainResponse?.headers()['content-security-policy']).toContain("script-src 'self'");
      expect(mainResponse?.headers()['content-security-policy']).not.toContain(cdn);
      const iframe = page.locator('iframe.renderer-frame');
      await expect(iframe).toBeVisible();
      await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      await expect(iframe).toHaveAttribute('credentialless', '');
      const frame = page.frameLocator('iframe.renderer-frame');
      if (kind === 'folder') {
        // Even a trusted CDN must not become a redirect path into another folder session.
        await expect(frame.getByRole('heading', { name: 'CDN preview' })).toBeVisible();
        await expect(frame.locator('body')).not.toHaveAttribute('data-module');
        await expect(frame.locator('cdn-greeting')).toBeEmpty();
        const other = await page.request.post(`${rendererOrigin}/render`, {
          headers: { origin: 'null' },
          form: { publicCode, path: 'index.html', nonce: 'other-session-nonce-1234' },
          maxRedirects: 0,
        });
        expect(other.status()).toBe(303);
        const otherUrl = new URL(other.headers().location ?? '', rendererOrigin).href;
        await page.route(`${cdn}/redirect.js`, (route) => {
          requests.push('/redirect.js');
          return route.fulfill({
            status: 302,
            headers: { location: otherUrl.replace(/index\.html$/u, 'other.js') },
            body: '',
          });
        });
        const redirected = await frame.locator('body').evaluate(
          (_body, url) =>
            new Promise<string>((resolve) => {
              const script = document.createElement('script');
              script.src = url;
              script.onload = () => resolve('loaded');
              script.onerror = () => resolve('blocked');
              document.body.append(script);
            }),
          `${cdn}/redirect.js`,
        );
        expect(redirected).toBe('blocked');
        expect(requests).toEqual([]);
        expect(prohibitedRequests).toEqual([]);
        expect(await frame.locator('body').getAttribute('data-other-session')).toBeNull();
        await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'ready');
        return;
      }
      await expect(frame.locator('cdn-greeting')).toHaveText('CDN component ready');
      await expect(frame.locator('cdn-greeting')).toHaveCSS('color', 'rgb(1, 2, 3)');
      await expect(frame.locator('body')).toHaveAttribute('data-module', 'ready');
      await expect(frame.locator('body')).toHaveAttribute('data-connections', 'blocked,blocked');
      expect(JSON.parse((await frame.locator('body').getAttribute('data-probe')) ?? '{}')).toEqual({
        origin: 'null',
        parentDom: false,
        parentStorage: false,
        cookies: false,
      });
      await expect
        .poll(() =>
          frame.getByAltText('CDN dot').evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBe(1);
      expect(requests.sort()).toEqual([
        '/chunk.js',
        '/dot.png',
        '/library.js',
        '/module.js',
        '/style.css',
      ]);
      expect(prohibitedRequests).toEqual([]);
      expect(await frame.locator('body').getAttribute('data-untrusted')).toBeNull();
      expect(
        await page.evaluate(() => ({
          dom: document.body.dataset.cdnLeak ?? null,
          storage: localStorage.getItem('cdn-leak'),
        })),
      ).toEqual({ dom: null, storage: null });
      await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'ready');

      // A trusted CDN is still forbidden in the parent dashboard/viewer document.
      await page.evaluate(
        (origin) =>
          new Promise<void>((resolve) => {
            const script = document.createElement('script');
            script.src = `${origin}/parent.js`;
            script.onload = script.onerror = () => resolve();
            document.head.append(script);
          }),
        cdn,
      );
      expect(requests).not.toContain('/parent.js');
    },
  );
}
