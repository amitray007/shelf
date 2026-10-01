import { expect, test } from '@playwright/test';

import { markdownShareId, shareSecret } from './fixtures.js';

for (const fragment of ['', '#short']) {
  test(`incomplete protected link explains how to open it (${fragment || 'missing fragment'})`, async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/public/')) requests.push(request.url());
    });
    await page.goto(`/s/${markdownShareId}${fragment}`);
    await expect(
      page.getByRole('heading', { name: 'This protected link is incomplete' }),
    ).toBeVisible();
    await expect(
      page.getByText('Open the complete link from the sender, including the part after #.'),
    ).toBeVisible();
    await expect(page).toHaveURL(`/s/${markdownShareId}`);
    expect(requests).toEqual([]);
  });
}

for (const [name, path] of [
  ['rejected protected link', `/s/${markdownShareId}#${'t'.repeat(43)}`],
  ['unknown protected link', `/s/shr_${'0'.repeat(22)}#${shareSecret}`],
  ['unknown public link', '/s/Missing12345'],
] as const) {
  test(`${name} keeps the unavailable state`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'This artifact is unavailable' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'This protected link is incomplete' }),
    ).toHaveCount(0);
  });
}
