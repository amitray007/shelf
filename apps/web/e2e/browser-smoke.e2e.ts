import { expect, type Locator, type Page, test } from '@playwright/test';
import type axe from 'axe-core';
import type { AxeResults } from 'axe-core';

import { htmlShareId, markdownShareId, shareSecret, workspaceId } from './fixtures.js';

declare global {
  interface Window {
    axe: { run: typeof axe.run };
    shelfBoundaryProbe?: {
      readonly eventOrigin: string;
      readonly probe: {
        readonly fetchAttempted: boolean;
        readonly imageAttempted: boolean;
        readonly origin: string;
        readonly parentReadable: boolean;
        readonly parentStorage: boolean;
        readonly popupOpened: boolean;
        readonly topNavigationAssigned: boolean;
        readonly xhrAttempted: boolean;
      };
    };
  }
}

async function expectNoHorizontalOverflow(page: Page, surfaces: Locator[] = []): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
  for (const surface of surfaces) {
    await expect
      .poll(() => surface.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  }
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ url: '/__fixture/axe.js' });
  const results: AxeResults = await page.evaluate(() => window.axe.run(document));
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
    })),
  ).toEqual([]);
}

function trackPageErrors(page: Page): { errors: string[]; assertClean(): void } {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return {
    errors,
    assertClean() {
      expect(errors).toEqual([]);
    },
  };
}

async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Keyboard navigation did not reach the expected control.');
}

test('the authenticated utility stays artifact-first, accessible, and responsive', async ({
  page,
}, testInfo) => {
  const diagnostics = trackPageErrors(page);

  await page.goto(`/app/w/${workspaceId}/artifacts`);
  await expect(page.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeVisible();
  await expect(page.getByText('shelf publish ./path --share')).toBeVisible();
  await expect(page.getByRole('link', { name: 'idea.md' })).toBeVisible();
  await expect(page.getByText('Collections', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'idea.md' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'idea.md' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'One useful idea',
  );
  await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  await expectNoHorizontalOverflow(page, [
    page.locator('.dashboard-main'),
    page.locator('.artifact-surface'),
  ]);
  if (testInfo.project.name === 'mobile-chromium') {
    expect(
      await page
        .locator('.artifact-management-grid')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    ).toBe(1);
    expect(
      await page
        .locator('.artifact-heading')
        .evaluate((element) => getComputedStyle(element).flexDirection),
    ).toBe('column');
  }

  await page.getByRole('link', { name: 'Access' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
  const issue = page.getByRole('button', { name: 'Issue credential' });
  await focusWithKeyboard(page, issue);
  expect(await issue.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  expect(await issue.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );
  await page.keyboard.press('Enter');
  const name = page.getByRole('textbox', { name: 'Agent name' });
  await expect(name).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Issue access credential' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(issue).toBeFocused();
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);
  await expectNoAxeViolations(page);
  diagnostics.assertClean();
});

test('anonymous dashboard requests collapse to the owner sign-in surface', async ({
  page,
  context,
}) => {
  const diagnostics = trackPageErrors(page);
  await context.addCookies([
    { name: 'shelf-browser-anonymous', value: '1', url: 'http://127.0.0.1:43873' },
  ]);

  await page.goto('/app');
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fapp$/u);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Open your artifact shelf' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email' })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  diagnostics.assertClean();
});

test('the public viewer scrubs its capability and reloads from tab-local state', async ({
  page,
}) => {
  const diagnostics = trackPageErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto('/signin');
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await expect(page).toHaveURL(`/s/${markdownShareId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'One useful idea' })).toBeVisible();
  expect(requests.some((url) => url.includes(shareSecret))).toBe(false);
  await expect(page.locator('body')).not.toContainText(shareSecret);
  expect(
    await page.evaluate(
      (secret) =>
        Object.entries(localStorage).some(
          ([key, value]) => key.includes(secret) || value === secret,
        ),
      shareSecret,
    ),
  ).toBe(false);
  await expectNoHorizontalOverflow(page, [page.locator('.artifact-surface')]);
  await expectNoAxeViolations(page);

  await page.goBack();
  await expect(page).toHaveURL('/signin');
  expect(page.url()).not.toContain(shareSecret);
  await page.goForward();
  await expect(page).toHaveURL(`/s/${markdownShareId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'One useful idea' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'One useful idea' })).toBeVisible();
  await expect(page).toHaveURL(`/s/${markdownShareId}`);

  const freshTab = await page.context().newPage();
  await freshTab.goto(`/s/${markdownShareId}`);
  await expect(
    freshTab.getByRole('heading', { level: 1, name: 'This artifact is unavailable' }),
  ).toBeVisible();
  await freshTab.close();
  diagnostics.assertClean();
});

test('reduced motion and the 200 percent layout equivalent preserve utility', async ({
  page,
}, testInfo) => {
  const diagnostics = trackPageErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/app/access');

  await page.getByRole('button', { name: 'Issue credential' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue access credential' });
  await expect(dialog).toBeVisible();
  const reducedTransition = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: style.transitionDuration, property: style.transitionProperty };
  });
  expect(reducedTransition.property).toBe('opacity');
  const reducedSeconds = Number.parseFloat(reducedTransition.duration);
  expect(reducedSeconds).toBeLessThanOrEqual(0.25);
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Issue credential' }).click();
  const defaultSeconds = Number.parseFloat(
    await dialog.evaluate((element) => getComputedStyle(element).transitionDuration),
  );
  expect(reducedSeconds).toBeLessThan(defaultSeconds);
  await page.keyboard.press('Escape');
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);

  if (testInfo.project.name === 'zoom-200-chromium') {
    await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Dashboard' })).toBeVisible();
    await expectNoAxeViolations(page);
  }
  diagnostics.assertClean();
});

test('the active renderer cannot escape its opaque sandbox', async ({ page, context }) => {
  const canaryRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const appApiRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const rendererRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const requestCaptures: Promise<void>[] = [];
  let popupCount = 0;
  context.on('page', () => {
    popupCount += 1;
  });
  await context.addCookies([
    {
      name: 'renderer-cookie-canary',
      value: 'present',
      url: 'http://127.0.0.1:43874/render',
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'navigation-cookie-canary',
      value: 'present',
      url: 'https://navigation-canary.invalid/',
      httpOnly: true,
      sameSite: 'None',
      secure: true,
    },
  ]);
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if (
        typeof event.data === 'object' &&
        event.data !== null &&
        event.data.type === 'shelf:test-boundary'
      ) {
        window.shelfBoundaryProbe = { eventOrigin: event.origin, probe: event.data.probe };
      }
    });
  });
  page.on('request', (request) => {
    requestCaptures.push(
      request.allHeaders().then((headers) => {
        const entry = { url: request.url(), headers };
        if (entry.url === 'http://127.0.0.1:43873/api/v1/renderer-canary') {
          appApiRequests.push(entry);
        }
        if (entry.url === 'http://127.0.0.1:43874/render') rendererRequests.push(entry);
      }),
    );
  });
  await page.route('https://*.invalid/**', async (route) => {
    const url = route.request().url();
    canaryRequests.push({
      url,
      headers: await route.request().allHeaders(),
    });
    if (url.startsWith('https://navigation-canary.invalid/')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Navigation canary</title>',
      });
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });
  await page.goto(`/s/${htmlShareId}#${shareSecret}`);
  await expect(page).toHaveURL(`/s/${htmlShareId}`);
  const frame = page.locator('iframe[title="idea.html isolated preview"]');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(frame).toHaveAttribute('allow', '');
  await expect(frame).toHaveAttribute('credentialless', '');
  await expect.poll(() => page.evaluate(() => window.shelfBoundaryProbe ?? null)).not.toBeNull();
  expect(await page.evaluate(() => window.shelfBoundaryProbe)).toEqual({
    eventOrigin: 'null',
    probe: {
      fetchAttempted: true,
      imageAttempted: true,
      origin: 'null',
      parentReadable: false,
      parentStorage: false,
      popupOpened: false,
      topNavigationAssigned: false,
      xhrAttempted: true,
    },
  });
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.rendererLeak ?? null))
    .toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('renderer-canary'))).toBeNull();
  await expect(page.getByText('Preview unavailable')).toBeVisible();
  await Promise.all(requestCaptures);

  const prohibited = canaryRequests.filter(
    (request) => !request.url.startsWith('https://navigation-canary.invalid/'),
  );
  expect(prohibited).toEqual([]);
  expect(appApiRequests).toEqual([]);
  expect(rendererRequests).toHaveLength(1);
  expect(rendererRequests[0]?.headers.cookie).toBeUndefined();
  expect(popupCount).toBe(0);
  await expect(page).toHaveURL(`/s/${htmlShareId}`);
  const navigation = canaryRequests.filter((request) =>
    request.url.startsWith('https://navigation-canary.invalid/'),
  );
  expect(navigation).toHaveLength(1);
  expect(navigation[0]?.headers.cookie).toBeUndefined();
  expect(navigation[0]?.headers.referer).toBeUndefined();
});
