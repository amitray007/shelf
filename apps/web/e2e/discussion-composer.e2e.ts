import { expect, test } from '@playwright/test';

import { folderShareId, shareSecret } from './fixtures.js';

test('folder discussion composer stays compact when the sidebar reopens', async ({ page }) => {
  await page.route(`**/api/v1/public/shares/${folderShareId}/sessions`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.resolution.commentPolicy = 'shared';
    await route.fulfill({ response, json: payload });
  });
  await page.route(`**/api/v1/public/shares/${folderShareId}/resolve`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), commentPolicy: 'shared' },
    });
  });
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  await expect(page.getByRole('region', { name: 'Folder browser' })).toBeVisible();
  const discussionTab = page.getByRole('tab', { name: 'Show discussion', exact: true });
  if (await discussionTab.isVisible()) await discussionTab.click();
  else await page.getByRole('button', { name: 'Open discussion' }).click();

  const draft = page.getByRole('textbox', { name: 'Start a discussion…' });
  const composer = page.locator('.review-chat-new-thread .review-composer-input');
  const expectCompact = async () => {
    await expect(draft).toBeVisible();
    await expect
      .poll(async () => (await composer.boundingBox())?.height ?? 0)
      .toBeLessThanOrEqual(80);
  };
  await expectCompact();
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await page.getByRole('button', { name: 'Close discussion', exact: true }).click();
    await expect(draft).toBeHidden();
    await page.getByRole('button', { name: 'Open discussion' }).click();
    await expectCompact();
  }
  await draft.fill('Keep this draft.');
  await page.getByRole('tab', { name: 'Show file tree' }).click();
  await discussionTab.click();
  await expect(draft).toHaveValue('Keep this draft.');
  await expectCompact();

  await draft.fill(Array.from({ length: 12 }, () => 'A line in a longer comment.').join('\n'));
  await expect.poll(async () => (await composer.boundingBox())?.height ?? 0).toBeGreaterThan(80);
  await expect
    .poll(async () => (await composer.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(160);
  await page.getByRole('button', { name: 'Close discussion', exact: true }).click();
  await page.getByRole('button', { name: 'Open discussion' }).click();
  await expect(draft).toBeVisible();
  await expect
    .poll(async () => (await composer.boundingBox())?.height ?? 0)
    .toBeLessThanOrEqual(160);
  await draft.fill('');
  await expectCompact();
});
