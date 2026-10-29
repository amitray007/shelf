import { expect, test } from '@playwright/test';
import { htmlShareId, rendererOrigin, shareSecret } from './fixtures.js';

for (const fault of ['503', 'reset', 'persistent'] as const) {
  test(`HTML renderer recovers from ${fault} with bounded authorized POSTs`, async ({ page }) => {
    let requests = 0;
    const nonces = new Set<string>();
    await page.route(`${rendererOrigin}/render`, async (route) => {
      requests += 1;
      expect(route.request().method()).toBe('POST');
      const fields = new URLSearchParams(route.request().postData() ?? '');
      nonces.add(fields.get('nonce') ?? '');
      expect(route.request().url()).not.toContain(shareSecret);
      if (requests === 1 || fault === 'persistent') {
        if (fault === 'reset') await route.abort('connectionreset');
        else await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' });
        return;
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "location.href = 'https://navigation-canary.invalid/leak';",
        '',
      );
      await route.fulfill({ response, body });
    });
    await page.goto(`/s/${htmlShareId}#${shareSecret}`);
    if (fault === 'persistent') {
      await expect.poll(() => requests, { timeout: 10_000 }).toBe(5);
      await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'unavailable');
    } else {
      await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'ready', {
        timeout: 10_000,
      });
      expect(requests).toBe(2);
      expect(nonces.size).toBe(2);
      // A later navigation must still terminate the recovered document.
      await page.locator('.renderer-frame').evaluate((frame: HTMLIFrameElement) => {
        frame.src = 'about:blank#escape';
      });
      await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'unavailable');
      expect(requests).toBe(2);
    }
  });
}
