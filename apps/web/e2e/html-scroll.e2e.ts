import { expect, test } from '@playwright/test';

import {
  folderResolution,
  folderShareId,
  folderTreePage,
  htmlShareId,
  rendererOrigin,
  shareSecret,
} from './fixtures.js';

for (const surface of ['file', 'public folder', 'protected folder'] as const) {
  test(`${surface} HTML scrolls after the isolated preview loads`, async ({ page }) => {
    let url = `/s/${htmlShareId}#${shareSecret}`;
    if (surface !== 'file') {
      const prefix =
        surface === 'public folder'
          ? '/api/v1/public/links/CssFolder123'
          : `/api/v1/public/shares/${folderShareId}`;
      url = surface === 'public folder' ? '/s/CssFolder123' : `/s/${folderShareId}#${shareSecret}`;
      if (surface === 'public folder') {
        await page.route(`**${prefix}/resolve*`, (route) =>
          route.fulfill({
            json: {
              ...folderResolution,
              accessType: 'public',
              publicCode: 'CssFolder123',
              action: { type: 'tree', path: `${prefix}/tree` },
            },
          }),
        );
      }
      await page.route(new RegExp(`${prefix}/tree(?:[/?]|$)`), (route) =>
        route.fulfill({
          json: {
            ...folderTreePage,
            items: [
              {
                kind: 'file',
                path: 'mockup.html',
                mediaType: 'text/html',
                byteCount: 100,
                contentHash: `sha256:${'a'.repeat(64)}`,
              },
            ],
          },
        }),
      );
    }

    let releaseRenderer = () => {};
    const rendererGate = new Promise<void>((resolve) => {
      releaseRenderer = resolve;
    });
    await page.route(`${rendererOrigin}/render`, async (route) => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(
          '</body>',
          '<div style="height: 2400px">Long document</div><button>End of document</button></body>',
        )
        .replace("location.href = 'https://navigation-canary.invalid/leak';", '');
      await rendererGate;
      await route.fulfill({ response, body });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const stage = page.locator('.renderer-stage');
    const iframe = page.locator('.renderer-frame');
    try {
      await expect(stage).toHaveAttribute('data-status', 'loading');
      await expect(iframe).toHaveCSS('opacity', '0');
      await expect(iframe).toHaveAttribute('tabindex', '-1');
      await expect(iframe).toHaveAttribute('aria-hidden', 'true');
    } finally {
      releaseRenderer();
    }
    await expect(stage).toHaveAttribute('data-status', 'ready');
    await expect(iframe).not.toHaveAttribute('tabindex', '-1');
    await expect(iframe).toHaveAttribute('aria-hidden', 'false');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(iframe).toHaveAttribute('credentialless', '');
    const body = page.frameLocator('.renderer-frame').locator('body');
    await expect
      .poll(() => body.evaluate(() => document.documentElement.scrollHeight - innerHeight))
      .toBeGreaterThan(1000);

    await iframe.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => body.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.mouse.wheel(0, 4000);
    await expect(body.getByRole('button', { name: 'End of document' })).toBeInViewport();
    await page.mouse.wheel(0, -4000);
    await expect.poll(() => body.evaluate(() => window.scrollY)).toBe(0);
    await expect(stage).toHaveAttribute('data-status', 'ready');
  });
}
