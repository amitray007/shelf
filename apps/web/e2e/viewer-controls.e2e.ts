import { expect, test } from '@playwright/test';

import {
  artifactId,
  commentThreads,
  folderShareId,
  htmlShareId,
  markdownShareId,
  pdfShareId,
  publicPdfCode,
  rendererOrigin,
  shareSecret,
} from './fixtures.js';

for (const [kind, shareId] of [
  ['file', markdownShareId],
  ['folder', folderShareId],
] as const) {
  test(`${kind} Markdown stays centered and fluid as its sidebar changes`, async ({ page }) => {
    await page.goto(`/s/${shareId}#${shareSecret}`);
    const document = page.locator('.artifact-document');
    const markdown = document.locator('.markdown-body');
    await expect(markdown).toBeVisible();
    const expectFluidWidth = async () => {
      await expect
        .poll(async () =>
          document.evaluate((element) => {
            const content = element.querySelector('.markdown-body');
            return (content?.getBoundingClientRect().width ?? 0) / element.clientWidth;
          }),
        )
        .toBeGreaterThanOrEqual(0.8);
      const margins = await document.evaluate((element) => {
        const outer = element.getBoundingClientRect();
        const inner = element.querySelector('.markdown-body')?.getBoundingClientRect();
        if (!inner) throw new Error('Markdown content is missing');
        return { left: inner.left - outer.left, right: outer.right - inner.right };
      });
      expect(Math.abs(margins.left - margins.right)).toBeLessThanOrEqual(1);
      if ((page.viewportSize()?.width ?? 0) > 640) expect(margins.left).toBeGreaterThan(24);
      expect(
        await page.evaluate(() => window.document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    };
    await expectFluidWidth();
    if (kind === 'folder') {
      await page.getByRole('button', { name: 'Show controls' }).click();
      await page.getByRole('button', { name: /Collapse folder .* sidebar/u }).click();
      await expectFluidWidth();
      await page.getByRole('button', { name: /Open folder .* sidebar/u }).click();
      await expectFluidWidth();
    }
  });
}

test('public and protected viewers start with one hidden controls surface', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);

  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toBeHidden();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(page.locator('.viewer-toolbar')).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toHaveCount(1);
  await expect(page.locator('.viewer-toolbar .wordmark')).toHaveText('shelf');
  await expect(page.locator('.viewer-toolbar .wordmark')).toBeVisible();
  const toolbar = page.locator('.viewer-toolbar');
  expect(await toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  const logo = await toolbar.locator('.wordmark').boundingBox();
  const file = await toolbar.locator('.viewer-file-slot').boundingBox();
  expect(logo).not.toBeNull();
  expect(file).not.toBeNull();
  expect((logo?.x ?? 0) + (logo?.width ?? 0)).toBeLessThanOrEqual(file?.x ?? 0);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();

  await page.goto(`/s/${publicPdfCode}`);
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toBeHidden();
});

test('More viewer controls reveals revision, mode, and download actions', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await page.getByRole('button', { name: 'Show controls' }).click();

  const more = page.locator('.viewer-more');
  await expect(more.locator('summary')).toBeVisible();
  await more.locator('summary').click();
  await expect(more.locator('.viewer-more-panel')).toBeVisible();
  await expect(more.getByRole('combobox', { name: 'Select revision' })).toBeVisible();
  await expect(more.getByRole('tab', { name: 'Preview' })).toBeVisible();
  await expect(more.getByRole('tab', { name: 'Source' })).toBeVisible();
  await expect(more.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});

test('hiding controls preserves the HTML frame and discussion draft', async ({ page }) => {
  // The security fixture deliberately navigates itself away. Keep that probe in its
  // dedicated sandbox test; this test needs a stable document to check preservation.
  await page.route(`${rendererOrigin}/render`, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "location.href = 'https://navigation-canary.invalid/leak';",
      '',
    );
    await route.fulfill({ response, body });
  });
  await page.goto(`/s/${htmlShareId}#${shareSecret}`);
  await page.getByRole('button', { name: 'Show controls' }).click();
  const frame = page.locator('iframe[title="idea.html isolated preview"]');
  await expect(frame).toBeVisible();
  await page.evaluate(() => {
    (globalThis as { __viewerFrame?: Element | undefined }).__viewerFrame =
      document.querySelector('iframe[title="idea.html isolated preview"]') ?? undefined;
  });

  await page.getByRole('button', { name: 'Open file discussions sidebar' }).click();
  const draft = page.getByRole('textbox', { name: 'Start a discussion…' });
  await draft.fill('Keep this unsent review draft.');
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeFocused();
  await expect(draft).toBeHidden();
  await expect(frame).toBeVisible();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(draft).toHaveValue('Keep this unsent review draft.');
  await expect(draft).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (globalThis as { __viewerFrame?: Element | undefined }).__viewerFrame ===
        document.querySelector('iframe[title="idea.html isolated preview"]'),
    ),
  ).toBe(true);
});

test('private preview starts visible and remembers hidden controls after reload', async ({
  page,
}) => {
  await page.goto(`/preview/${artifactId}`);
  await expect(page.getByRole('button', { name: 'Hide controls' })).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toBeVisible();

  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toBeHidden();
});

test('a folder without a landing file opens its listing without a separate Files navbar button', async ({
  page,
}) => {
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.items = payload.items.filter(
      (entry: { path: string }) =>
        !['index.html', 'index.htm', 'README.md', 'readme.md'].includes(entry.path),
    );
    await route.fulfill({ response, json: payload });
  });

  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  await expect(page.getByRole('region', { name: 'Folder files' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'release-output/checksums.txt' })).toBeVisible();

  const closeFiles = page.getByRole('button', { name: 'Close files sidebar', exact: true });
  if (await closeFiles.isVisible()) await closeFiles.click();

  await page.getByRole('button', { name: 'release-output/checksums.txt' }).click();
  await expect(page.getByRole('region', { name: 'Folder files' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(
    page.locator('.viewer-toolbar').getByRole('button', { name: 'Files', exact: true }),
  ).toHaveCount(0);
});

test('folder navigation stays visible when the navbar is hidden', async ({ page }) => {
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  const sidebar = page.getByTestId('viewer-sidebar');
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeVisible();
  await expect(page.locator('.viewer-toolbar')).toBeHidden();
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().top))
    .toBe(0);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeVisible();
  const closeFiles = page.getByRole('button', { name: 'Close files sidebar', exact: true });
  if (await closeFiles.isVisible()) {
    await closeFiles.click();
    await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeHidden();
    await page.getByRole('button', { name: 'Show controls' }).click();
    await page.getByRole('button', { name: 'Open folder files sidebar' }).click();
    await page.getByRole('button', { name: 'Hide controls' }).click();
    await page.keyboard.press('Escape');
    await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeHidden();
  }
});

test('folder discussion stays open and preserves a reply when the navbar is hidden', async ({
  page,
}) => {
  await page.route(`**/api/v1/public/shares/${folderShareId}/resolve`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), commentPolicy: 'shared' },
    });
  });
  await page.route(`**/api/v1/public/shares/${folderShareId}/comments/query`, async (route) => {
    await route.fulfill({ json: { items: commentThreads, nextCursor: null } });
  });
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  await page.getByRole('tab', { name: 'Show discussion', exact: true }).click();
  await page.getByRole('button', { name: 'Discussion started by Ada' }).click();
  const reply = page.getByRole('textbox', { name: 'Reply to this discussion…' });
  await reply.fill('Keep reviewing with the navbar hidden.');
  await page.getByRole('button', { name: 'Show controls' }).click();
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(reply).toBeVisible();
  await expect(reply).toHaveValue('Keep reviewing with the navbar hidden.');
  await page.getByRole('tab', { name: 'Show file tree', exact: true }).click();
  await expect(reply).toBeHidden();
  await page.getByRole('tab', { name: 'Show discussion', exact: true }).click();
  await expect(reply).toHaveValue('Keep reviewing with the navbar hidden.');
});

test('PDF controls remain usable at narrow width after being revealed', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/s/${pdfShareId}#${shareSecret}`);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
  await page.locator('.viewer-more > summary').click();
  await expect(page.getByRole('button', { name: 'Next PDF page' })).toBeVisible();
  const zoom = page.getByLabel('PDF zoom');
  await page.getByRole('button', { name: 'Zoom in PDF' }).click();
  const selectedZoom = await zoom.textContent();
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await page.locator('.viewer-more > summary').click();
  await expect(zoom).toHaveText(selectedZoom ?? '');
  await expect(page.getByRole('button', { name: 'Hide controls' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('hiding controls preserves source mode and scroll position', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await page.getByRole('button', { name: 'Show controls' }).click();
  await page.locator('.viewer-more > summary').click();
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  const source = page.locator('.source-view-content > diffs-container');
  await expect(source).toBeVisible();
  await source.evaluate((element) => {
    element.scrollTop = 120;
  });
  const scroll = await source.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Hide controls' }).click();
  await expect(source).toBeVisible();
  await page.getByRole('button', { name: 'Show controls' }).click();
  await expect(source).toBeVisible();
  expect(await source.evaluate((element) => element.scrollTop)).toBe(scroll);
});

test('a folder landing document opens directly with controls hidden', async ({ page }) => {
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const file = payload.items.find((entry: { kind: string }) => entry.kind === 'file');
    payload.items = [{ ...file, path: 'README.md', mediaType: 'text/markdown' }];
    await route.fulfill({ response, json: payload });
  });
  await page.route(
    `**/api/v1/public/shares/${folderShareId}/tree/content?path=README.md`,
    async (route) => {
      await route.fulfill({
        contentType: 'text/markdown',
        body: '# Folder overview\n\nStart here.',
      });
    },
  );
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  await expect(page.getByRole('heading', { name: 'Folder overview' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Folder files' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show controls' })).toBeVisible();
});
