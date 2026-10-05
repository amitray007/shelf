import { expect, test } from '@playwright/test';

import {
  htmlResolution,
  htmlShareId,
  markdownResolution,
  markdownShareId,
  rendererOrigin,
  shareSecret,
} from './fixtures.js';

for (const [format, shareId, resolution] of [
  ['Markdown', markdownShareId, markdownResolution],
  ['HTML', htmlShareId, htmlResolution],
] as const) {
  test(`${format} background updates preserve the preview until notification Refresh`, async ({
    page,
  }) => {
    if (format === 'HTML') {
      // The sandbox fixture attempts navigation; this test needs a stable preview.
      await page.route(`${rendererOrigin}/render`, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          "location.href = 'https://navigation-canary.invalid/leak';",
          '',
        );
        await route.fulfill({ response, body });
      });
    }
    let contentRequests = 0;
    let rendererRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith(`/shares/${shareId}/content`)) contentRequests++;
      if (request.url() === `${rendererOrigin}/render`) rendererRequests++;
    });
    await page.goto(`/s/${shareId}#${shareSecret}`);
    const preview =
      format === 'Markdown' ? page.locator('.markdown-body') : page.locator('.renderer-stage');
    if (format === 'Markdown') await expect(preview).toContainText('One useful idea');
    else await expect(preview).toHaveAttribute('data-status', 'ready');
    await preview.evaluate((element) => element.setAttribute('data-preserved', 'yes'));
    const initialContentRequests = contentRequests;
    const initialRendererRequests = rendererRequests;
    const newerRevision = {
      ...resolution.revision,
      revisionId: `rev_${'z'.repeat(22)}`,
      revisionNumber: resolution.revision.revisionNumber + 1,
    };
    const latest = {
      revisionId: newerRevision.revisionId,
      revisionNumber: newerRevision.revisionNumber,
      createdAt: newerRevision.createdAt,
    };
    const updated = { ...resolution, revision: newerRevision, latestRevision: latest };
    let checks = 0;
    let finishCheck = () => {};
    const checkGate = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    await page.route(`**/shares/${shareId}/resolve`, async (route) => {
      checks++;
      await checkGate;
      await route.fulfill({ json: updated });
    });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => checks).toBe(1);
    await expect(page.locator('.viewer-update-check')).toBeEnabled();
    await expect(page.locator('.viewer-update-icon')).not.toHaveAttribute('data-refreshing');
    finishCheck();
    const notification = page.locator('.viewer-update-notification');
    await expect(notification.getByRole('status')).toHaveText('A newer version is available');
    await expect(preview).toHaveAttribute('data-preserved', 'yes');
    expect(contentRequests).toBe(initialContentRequests);
    expect(rendererRequests).toBe(initialRendererRequests);
    // A second focus check keeps the same preview and one persistent notice.
    const checkedAgain = page.waitForResponse(`**/shares/${shareId}/resolve`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await checkedAgain;
    await expect(notification).toHaveCount(1);
    await expect(preview).toHaveAttribute('data-preserved', 'yes');
    expect(contentRequests).toBe(initialContentRequests);
    expect(rendererRequests).toBe(initialRendererRequests);
    await expect(notification).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
    // Protected loaders renew their authority and can receive the current resolution there.
    await page.route(`**/shares/${shareId}/sessions`, async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({ response, json: { ...session, resolution: updated } });
    });
    if (format === 'Markdown') {
      await page.route(`**/shares/${shareId}/content`, (route) =>
        route.fulfill({ contentType: 'text/markdown', body: '# Updated useful idea' }),
      );
    }
    await notification.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(notification).toHaveCount(0);
    if (format === 'Markdown') {
      await expect(preview).toContainText('Updated useful idea');
      expect(contentRequests).toBeGreaterThan(initialContentRequests);
    } else {
      await expect(preview).toHaveAttribute('data-status', 'ready');
      expect(rendererRequests).toBeGreaterThan(initialRendererRequests);
    }
    await expect(preview).not.toHaveAttribute('data-preserved');
  });
}

test('unchanged and failed background checks leave content and controls quiet', async ({
  page,
}) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  const preview = page.locator('.markdown-body');
  await expect(preview).toContainText('One useful idea');
  await preview.evaluate((element) => element.setAttribute('data-preserved', 'yes'));
  for (const status of [200, 503]) {
    await page.route(`**/shares/${markdownShareId}/resolve`, (route) =>
      route.fulfill({ status, json: status === 200 ? markdownResolution : {} }),
    );
    const checked = page.waitForResponse(`**/shares/${markdownShareId}/resolve`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await checked;
    await expect(page.locator('.viewer-update-notification')).toHaveCount(0);
    await expect(preview).toHaveAttribute('data-preserved', 'yes');
    await expect(page.locator('.viewer-update-icon')).not.toHaveAttribute('data-refreshing');
    await page.unroute(`**/shares/${markdownShareId}/resolve`);
  }
});

test('pinned shares do not check or offer to replace their revision on focus', async ({ page }) => {
  await page.route(`**/shares/${markdownShareId}/sessions`, async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    await route.fulfill({
      response,
      json: {
        ...session,
        resolution: {
          ...markdownResolution,
          target: {
            mode: 'pinned',
            revisionId: markdownResolution.revision.revisionId,
          },
          revisionAccess: 'target-only',
          navigation: undefined,
        },
      },
    });
  });
  let checks = 0;
  await page.route(`**/shares/${markdownShareId}/resolve`, (route) => {
    checks++;
    return route.fulfill({ json: markdownResolution });
  });
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await expect(page.locator('.markdown-body')).toContainText('One useful idea');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.viewer-update-notification')).toHaveCount(0);
  expect(checks).toBe(0);
});

test('public Latest links preserve content until notification Refresh', async ({ page }) => {
  const publicCode = 'Updates12345';
  const initial = {
    ...markdownResolution,
    accessType: 'public',
    publicCode,
    action: { type: 'content', path: `/api/v1/public/links/${publicCode}/content` },
  };
  const updated = {
    ...initial,
    revision: {
      ...initial.revision,
      revisionId: `rev_${'z'.repeat(22)}`,
      revisionNumber: 13,
    },
    latestRevision: {
      ...initial.latestRevision,
      revisionId: `rev_${'z'.repeat(22)}`,
      revisionNumber: 13,
    },
  };
  let changed = false;
  let contentRequests = 0;
  await page.route(`**/links/${publicCode}/resolve`, (route) =>
    route.fulfill({ json: changed ? updated : initial }),
  );
  await page.route(`**/links/${publicCode}/content*`, (route) => {
    contentRequests++;
    return route.fulfill({
      contentType: 'text/markdown',
      body: changed ? '# Updated public idea' : '# Original public idea',
    });
  });
  await page.goto(`/s/${publicCode}`);
  await expect(page.locator('.markdown-body')).toContainText('Original public idea');
  const initialRequests = contentRequests;
  changed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const notification = page.locator('.viewer-update-notification');
  await expect(notification).toContainText('A newer version is available');
  await expect(page.locator('.markdown-body')).toContainText('Original public idea');
  expect(contentRequests).toBe(initialRequests);
  await notification.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.markdown-body')).toContainText('Updated public idea');
  await expect(notification).toHaveCount(0);
  expect(contentRequests).toBeGreaterThan(initialRequests);
});
