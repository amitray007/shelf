import { expect, test } from '@playwright/test';

import { folderResolution, folderTreePage, rendererOrigin } from './fixtures.js';

const publicCode = 'SiteFolder12';
const prefix = `/api/v1/public/links/${publicCode}`;
const files = [
  ['index.html', 'text/html'],
  ['about.html', 'text/html'],
  ['css/base.css', 'text/css'],
  ['css/site.css', 'text/css'],
  ['data.json', 'application/json'],
  ['guide/index.html', 'text/html'],
  ['img/dot.png', 'image/png'],
  ['js/app.js', 'text/javascript'],
  ['js/classic.js', 'text/javascript'],
  ['js/lazy.js', 'text/javascript'],
  ['js/util.js', 'text/javascript'],
] as const;

test('folder HTML loads relative scripts, modules, styles, images, and data, and follows links', async ({
  page,
}) => {
  await page.route(`**${prefix}/resolve*`, (route) =>
    route.fulfill({
      json: {
        ...folderResolution,
        accessType: 'public',
        publicCode,
        action: { type: 'tree', path: `${prefix}/tree` },
      },
    }),
  );
  await page.route(new RegExp(`${prefix}/tree(?:[/?]|$)`), (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/content')) {
      return route.fulfill({ contentType: 'text/html', body: '<h1>Agent site</h1>' });
    }
    return route.fulfill({
      json: {
        ...folderTreePage,
        items: files.map(([path, mediaType], index) => ({
          kind: 'file',
          path,
          mediaType,
          byteCount: 100,
          contentHash: `sha256:${String(index).repeat(64).slice(0, 64)}`,
        })),
      },
    });
  });
  const externalRequests: string[] = [];
  await page.route(/^https:\/\/[a-z-]+-canary\.invalid\//u, (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  const rendererRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${rendererOrigin}/f/`)) {
      rendererRequests.push(new URL(request.url()).pathname.replace(/^\/f\/[^/]+\//u, ''));
    }
  });

  await page.goto(`/s/${publicCode}`);
  const index = page.locator('iframe[title="index.html isolated preview"]');
  await expect(index).toBeVisible();
  await expect(index).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frameLocator('iframe[title="index.html isolated preview"]');
  await expect(frame.getByRole('heading', { name: 'Agent site' })).toHaveCSS(
    'color',
    'rgb(1, 2, 3)',
  );
  await expect(frame.locator('#classic')).toHaveText('classic:ok');
  await expect(frame.locator('#module')).toHaveText('module:ok');
  await expect(frame.locator('#lazy')).toHaveText('lazy:ok');
  await expect(frame.locator('#data')).toHaveText('data:ok');
  await expect(frame.locator('#external')).toHaveText('external:blocked');
  await expect
    .poll(() => frame.locator('#dot').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  await expect
    .poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundImage))
    .toContain('/img/dot.png');
  expect(rendererRequests).toEqual(
    expect.arrayContaining([
      'index.html',
      'css/site.css',
      'css/base.css',
      'js/classic.js',
      'js/app.js',
      'js/util.js',
      'js/lazy.js',
      'data.json',
      'img/dot.png',
    ]),
  );

  // A link to another folder file opens that file in the viewer.
  await frame.getByRole('link', { name: 'About this site' }).click();
  const about = page.locator('iframe[title="about.html isolated preview"]');
  await expect(about).toBeVisible();
  const aboutFrame = page.frameLocator('iframe[title="about.html isolated preview"]');
  await expect(aboutFrame.getByRole('heading', { name: 'About page' })).toHaveCSS(
    'color',
    'rgb(1, 2, 3)',
  );
  // The link's fragment carries into the newly opened file.
  await expect(aboutFrame.getByText('Team section')).toBeInViewport();
  // Narrow viewports keep the files sidebar closed, so the tree is checked only where it renders.
  const aboutItem = page.getByRole('treeitem', { name: 'about.html', exact: true });
  if (await page.getByRole('tree').isVisible()) {
    await expect(aboutItem).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
  }

  await aboutFrame.getByRole('link', { name: 'Home' }).click();
  const home = page.locator('iframe[title="index.html isolated preview"]');
  await expect(home).toBeVisible();
  const homeFrame = page.frameLocator('iframe[title="index.html isolated preview"]');
  await expect(homeFrame.locator('#module')).toHaveText('module:ok');

  // Directory links open that directory's index.html.
  await homeFrame.getByRole('link', { name: 'Guide', exact: true }).click();
  const guideFrame = page.frameLocator('iframe[title="guide/index.html isolated preview"]');
  await expect(guideFrame.getByRole('heading', { name: 'Guide index' })).toHaveCSS(
    'color',
    'rgb(1, 2, 3)',
  );
  await guideFrame.getByRole('link', { name: 'Site home' }).click();
  await expect(homeFrame.locator('#module')).toHaveText('module:ok');

  // Same-document fragment links scroll inside the frame and keep it open.
  await homeFrame.locator('#section').click();
  await expect(homeFrame.locator('#details')).toBeInViewport();
  await homeFrame.getByRole('link', { name: 'Back to top' }).click();
  await expect(homeFrame.getByRole('heading', { name: 'Agent site' })).toBeInViewport();
  await expect(home).toBeVisible();
  await expect(page.locator('.renderer-stage')).toHaveAttribute('data-status', 'ready');
  expect(externalRequests).toEqual([]);
});

test('folder HTML opens while a slow image is still loading', async ({ page }) => {
  test.setTimeout(45_000);
  await page.route(`**${prefix}/resolve*`, (route) =>
    route.fulfill({
      json: {
        ...folderResolution,
        accessType: 'public',
        publicCode,
        action: { type: 'tree', path: `${prefix}/tree` },
      },
    }),
  );
  await page.route(new RegExp(`${prefix}/tree(?:[/?]|$)`), (route) =>
    route.fulfill({
      json: {
        ...folderTreePage,
        items: files.map(([path, mediaType], index) => ({
          kind: 'file',
          path,
          mediaType,
          byteCount: 100,
          contentHash: `sha256:${String(index).repeat(64).slice(0, 64)}`,
        })),
      },
    }),
  );
  await page.route(/^https:\/\/[a-z-]+-canary\.invalid\//u, (route) => route.abort());
  // The image holds the frame's window load event past the viewer's eight-second allowance.
  let releaseImage = () => {};
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route(`${rendererOrigin}/f/*/img/dot.png`, async (route) => {
    await imageGate;
    await route.continue().catch(() => {});
  });

  try {
    await page.goto(`/s/${publicCode}`);
    const stage = page.locator('.renderer-stage');
    await expect(stage).toHaveAttribute('data-status', 'ready');
    const frame = page.frameLocator('iframe[title="index.html isolated preview"]');
    await expect(frame.getByRole('heading', { name: 'Agent site' })).toBeVisible();
    await page.waitForTimeout(12_000);
    await expect(stage).toHaveAttribute('data-status', 'ready');
    await expect(frame.getByRole('heading', { name: 'Agent site' })).toBeVisible();
  } finally {
    releaseImage();
  }
});
