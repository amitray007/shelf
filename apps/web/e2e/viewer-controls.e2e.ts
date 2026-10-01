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
      const width = await document.evaluate((element) => {
        const content = element.querySelector('.markdown-body');
        if (content === null) throw new Error('Markdown content is missing');
        const styles = getComputedStyle(element);
        const horizontalPadding =
          Number.parseFloat(styles.paddingInlineStart) + Number.parseFloat(styles.paddingInlineEnd);
        return {
          actual: content.getBoundingClientRect().width,
          expected: Math.min(848, element.clientWidth - horizontalPadding),
        };
      });
      expect(Math.abs(width.actual - width.expected)).toBeLessThanOrEqual(1);
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
      await page.getByRole('button', { name: 'Open files sidebar' }).click();
      await expectFluidWidth();
      await page.getByRole('button', { name: 'Close files sidebar', exact: true }).click();
      await expectFluidWidth();
    }
  });
}

test('public and protected viewers start with a hidden floating details panel', async ({
  page,
}) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);

  const launcher = page.getByRole('button', { name: 'Open artifact details' });
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await expect(launcher).toBeVisible();
  await expect(panel).toBeHidden();
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const detailsTab = panel.getByRole('tab', { name: 'Details', exact: true });
  await detailsTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'View & actions', exact: true })).toBeFocused();
  await expect(panel.getByRole('tab', { name: 'View & actions', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(detailsTab).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Close artifact details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Open artifact details' })).toBeVisible();

  await page.goto(`/s/${publicPdfCode}`);
  await expect(page.getByRole('button', { name: 'Open artifact details' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Artifact details' })).toBeHidden();
});

test('floating details panel reveals file, mode, revision, and download actions', async ({
  page,
}) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await page.getByRole('button', { name: 'Open artifact details' }).click();

  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  await expect(panel.locator('.viewer-file-slot')).toBeVisible();
  await expect(panel.locator('.viewer-view-slot')).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Select revision' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Preview' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Source' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});

test('floating details renders rich publisher metadata as text', async ({ page }) => {
  await page.route(`**/api/v1/public/shares/${markdownShareId}/sessions`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.resolution.revision.publisherMetadata = {
      audience: 'release reviewers',
      buildNote: 'release <safe>',
      description: 'Prepared for a focused release review.',
      run_id: 'ci-4821',
      title: 'Release review',
    };
    await route.fulfill({ response, json: payload });
  });

  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await expect(page).toHaveTitle('Release review · shelf');
  await expect(panel.getByRole('heading', { name: 'Release review', exact: true })).toBeVisible();
  await expect(
    panel.getByText('Prepared for a focused release review.', { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Publisher metadata' })).toBeVisible();
  await expect(panel.getByText('release <safe>', { exact: true })).toBeVisible();
  await expect(panel.locator('script')).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'Publisher metadata' }).locator('dt')).toHaveText([
    'Audience',
    'Build Note',
    'Run id',
  ]);
});

test('opening details preserves the HTML frame and discussion draft', async ({ page }) => {
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
  const frame = page.locator('iframe[title="idea.html isolated preview"]');
  await expect(frame).toBeVisible();
  await page.evaluate(() => {
    (globalThis as { __viewerFrame?: Element | undefined }).__viewerFrame =
      document.querySelector('iframe[title="idea.html isolated preview"]') ?? undefined;
  });

  await page.getByRole('button', { name: 'Open discussion' }).click();
  await expect(page.locator('.viewer-sidebar-launcher-group')).toBeHidden();
  const draft = page.getByRole('textbox', { name: 'Start a discussion…' });
  await draft.fill('Keep this unsent review draft.');
  const frameBox = await frame.boundingBox();
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await expect(page.getByRole('dialog', { name: 'Artifact details' })).toBeVisible();
  expect(await frame.boundingBox()).toEqual(frameBox);
  await expect(frame).toBeVisible();
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

test('mobile details and discussion launchers close each other without losing a draft', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${htmlShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  const launcher = page.getByRole('button', { name: 'Open artifact details' });
  const draft = page.getByRole('textbox', { name: 'Start a discussion…' });

  await page.getByRole('button', { name: 'Open discussion' }).click();
  await draft.fill('Keep this mobile draft.');
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open discussion' })).toBeVisible();
  await expect(draft).toBeHidden();

  await page.getByRole('button', { name: 'Open discussion' }).click();
  await expect(panel).toBeHidden();
  await expect(draft).toBeVisible();
  await expect(draft).toHaveValue('Keep this mobile draft.');
});

test('private preview starts with its floating details panel closed after reload', async ({
  page,
}) => {
  await page.goto(`/preview/${artifactId}`);
  const launcher = page.getByRole('button', { name: 'Open artifact details' });
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await expect(launcher).toBeVisible();
  await expect(panel).toBeHidden();

  await launcher.click();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open artifact details' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Artifact details' })).toBeHidden();
});

test('a folder without a landing file opens its listing with a separate files launcher', async ({
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
  await expect(page.getByRole('button', { name: 'Open files sidebar' })).toBeVisible();
});

test('folder navigation starts closed and is independent from details', async ({ page }) => {
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  const sidebar = page.getByTestId('viewer-sidebar');
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeHidden();
  await page.getByRole('button', { name: 'Open files sidebar' }).click();
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeVisible();
  await page.getByRole('button', { name: 'Close files sidebar', exact: true }).click();
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeHidden();
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await expect(sidebar.locator('.viewer-sidebar-preserved')).toBeHidden();
});

test('folder discussion stays open and preserves a reply while details changes', async ({
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
  await page.getByRole('button', { name: 'Open discussion' }).click();
  await page.getByRole('button', { name: 'Discussion started by Ada' }).click();
  const reply = page.getByRole('textbox', { name: 'Reply to this discussion…' });
  await reply.fill('Keep reviewing while details is open.');
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await expect(reply).toBeVisible();
  await expect(reply).toHaveValue('Keep reviewing while details is open.');
  await expect(page.locator('.viewer-sidebar-launcher-group')).toBeHidden();
  await page.getByRole('button', { name: 'Close discussion', exact: true }).click();
  await expect(reply).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open files sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Open discussion' }).click();
  await expect(reply).toHaveValue('Keep reviewing while details is open.');
  await page.getByRole('tab', { name: 'Show file tree' }).click();
  await expect(page.locator('.viewer-sidebar-launcher-group')).toBeHidden();
  await page.getByRole('tab', { name: 'Show discussion', exact: true }).click();
  await expect(page.locator('.viewer-sidebar-launcher-group')).toBeHidden();
  await page.getByRole('button', { name: 'Close discussion', exact: true }).click();
  await page.getByRole('button', { name: 'Open files sidebar' }).click();
  await expect(page.getByRole('tab', { name: 'Show file tree' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.viewer-sidebar-launcher-group')).toBeHidden();
});

test('PDF controls remain usable at narrow width inside View & actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/s/${pdfShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next PDF page' })).toBeVisible();
  const zoom = page.getByLabel('PDF zoom');
  await page.getByRole('button', { name: 'Zoom in PDF' }).click();
  const selectedZoom = await zoom.textContent();
  await panel.getByRole('button', { name: 'Close artifact details' }).click();
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  await expect(zoom).toHaveText(selectedZoom ?? '');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('closing details preserves source mode and scroll position', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  await panel.getByRole('tab', { name: 'Source', exact: true }).click();
  const source = page.locator('.source-view-content > diffs-container');
  await expect(source).toBeVisible();
  await source.evaluate((element) => {
    element.scrollTop = 120;
  });
  const scroll = await source.evaluate((element) => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await panel.getByRole('button', { name: 'Close artifact details' }).click();
  await expect(source).toBeVisible();
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  await expect(source).toBeVisible();
  expect(await source.evaluate((element) => element.scrollTop)).toBe(scroll);
});

test('selecting a slow revision keeps the current content node and geometry', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  const panel = page.getByRole('dialog', { name: 'Artifact details' });
  await page.getByRole('button', { name: 'Open artifact details' }).click();
  await panel.getByRole('tab', { name: 'View & actions', exact: true }).click();
  const document = page.locator('.artifact-document');
  await expect(document).toBeVisible();
  await page.evaluate(() => {
    (globalThis as { __viewerDocument?: Element | undefined }).__viewerDocument =
      window.document.querySelector('.artifact-document') ?? undefined;
  });
  const bounds = await document.boundingBox();
  let releaseRevision!: () => void;
  const revisionGate = new Promise<void>((resolve) => {
    releaseRevision = resolve;
  });
  await page.route(`**/api/v1/public/shares/${markdownShareId}/sessions**`, async (route) => {
    await revisionGate;
    await route.continue();
  });

  const revision = panel.getByRole('combobox', { name: 'Select revision' });
  await revision.click();
  await page.getByRole('option', { name: '11th Revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading revision…' })).toBeVisible();
  await expect(document).toBeVisible();
  expect(await document.boundingBox()).toEqual(bounds);
  expect(
    await page.evaluate(
      () =>
        (globalThis as { __viewerDocument?: Element | undefined }).__viewerDocument ===
        window.document.querySelector('.artifact-document'),
    ),
  ).toBe(true);

  releaseRevision();
  await expect(page.getByRole('heading', { level: 1, name: 'Earlier useful idea' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Open artifact details' })).toBeVisible();
});
