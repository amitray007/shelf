import { expect, test } from '@playwright/test';

import { folderResolution, folderShareId, folderTreePage, shareSecret } from './fixtures.js';

for (const accessType of ['public', 'protected'] as const) {
  test(`${accessType} folder HTML loads its uploaded stylesheet inside the isolated renderer`, async ({
    page,
  }) => {
    const prefix =
      accessType === 'public'
        ? '/api/v1/public/links/CssFolder123'
        : `/api/v1/public/shares/${folderShareId}`;
    if (accessType === 'public') {
      await page.route(`**${prefix}/resolve*`, (route) =>
        route.fulfill({
          json: {
            ...folderResolution,
            accessType,
            publicCode: 'CssFolder123',
            action: { type: 'tree', path: `${prefix}/tree` },
          },
        }),
      );
    }
    await page.route(new RegExp(`${prefix}/tree(?:[/?]|$)`), (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/content')) {
        return route.fulfill({ contentType: 'text/html', body: '<h1>Styled folder mockup</h1>' });
      }
      return route.fulfill({
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
            {
              kind: 'file',
              path: 'theme.css',
              mediaType: 'text/css',
              byteCount: 100,
              contentHash: `sha256:${'b'.repeat(64)}`,
            },
          ],
        },
      });
    });
    const externalRequests: string[] = [];
    await page.route('https://styles-canary.invalid/**', (route) => {
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto(
      accessType === 'public' ? '/s/CssFolder123' : `/s/${folderShareId}#${shareSecret}`,
    );
    const iframe = page.locator('iframe[title="mockup.html isolated preview"]');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = page.frameLocator('iframe[title="mockup.html isolated preview"]');
    await expect(frame.getByRole('heading', { name: 'Styled folder mockup' })).toBeVisible();
    await expect(frame.locator('.layout')).toHaveCSS('display', 'grid');
    await expect(frame.locator('.layout')).toHaveCSS('grid-template-columns', '100px 200px');
    for (const [colorScheme, color, background] of [
      ['dark', 'rgb(126, 162, 255)', 'rgb(14, 14, 15)'],
      ['light', 'rgb(36, 86, 214)', 'rgb(251, 251, 250)'],
    ] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(frame.locator('body')).toHaveCSS('color', color);
      await expect(frame.locator('body')).toHaveCSS('background-color', background);
    }
    await expect(frame.locator('h1')).toHaveCSS('font-size', '24px');
    expect(externalRequests).toEqual([]);
  });
}
