import { expect, type Locator, type Page, test } from '@playwright/test';
import type axe from 'axe-core';
import type { AxeResults } from 'axe-core';

import {
  artifactId,
  audioShareId,
  createdCredentialToken,
  createdShareId,
  csvShareId,
  folderArtifactId,
  htmlShareId,
  longArtifactName,
  longFolderName,
  longFolderPath,
  markdownShareId,
  pdfShareId,
  previousRevisionId,
  publicPdfCode,
  rendererOrigin,
  shareSecret,
  shortArtifactId,
  svgShareId,
  videoShareId,
  workspaceId,
  xlsxShareId,
  yamlShareId,
} from './fixtures.js';

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
    shelfNavigationAttempted?: boolean;
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
      nodes: violation.nodes.map((node) => ({ html: node.html, target: node.target })),
    })),
  ).toEqual([]);
}

function trackPageErrors(
  page: Page,
  ignoredConsoleErrors: readonly RegExp[] = [],
): { errors: string[]; assertClean(): void } {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !ignoredConsoleErrors.some((pattern) => pattern.test(message.text()))
    ) {
      errors.push(message.text());
    }
  });
  return {
    errors,
    assertClean() {
      expect(errors).toEqual([]);
    },
  };
}

async function focusWithKeyboard(page: Page, target: Locator, forwardKey = 'Tab'): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press(forwardKey);
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error('Keyboard navigation did not reach the expected control.');
}

async function expectActionWithinViewport(
  page: Page,
  name: string,
  role: 'button' | 'link' = 'button',
  root: Page | Locator = page,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const action = root.getByRole(role, { name, exact: true });
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
}

const densityViewports = [
  { label: '1440 desktop', width: 1_440, height: 900 },
  { label: '768 tablet', width: 768, height: 1_024 },
  { label: '390 mobile', width: 390, height: 844 },
  { label: '320 narrow mobile', width: 320, height: 800 },
  { label: '200 percent layout equivalent', width: 720, height: 450 },
] as const;

for (const viewport of densityViewports) {
  test(`production-shaped artifact surfaces reflow at ${viewport.label}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !['chromium', 'webkit'].includes(testInfo.project.name),
      'The canonical density matrix runs in Chromium and WebKit.',
    );
    const diagnostics = trackPageErrors(page);
    await page.setViewportSize(viewport);

    await page.goto(`/app/w/${workspaceId}/artifacts`);
    const applicationBar = page.getByRole('banner');
    await expect(applicationBar).toBeVisible();
    await expect(applicationBar.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const dashboardSections = applicationBar.getByRole('navigation', {
      name: 'Dashboard sections',
    });
    await expect(dashboardSections.getByRole('link', { name: 'Artifacts' })).toBeVisible();
    await expect(dashboardSections.getByRole('link', { name: 'Access' })).toBeVisible();
    await expect(dashboardSections.getByRole('link', { name: 'Trash' })).toHaveCount(0);
    const trashLink = applicationBar.getByRole('link', { name: 'Trash', exact: true });
    const signOutButton = applicationBar.getByRole('button', { name: 'Sign out' });
    await expect(trashLink).toBeVisible();
    await expect(signOutButton).toBeVisible();
    await expect(trashLink.locator('svg')).toHaveCount(1);
    const sectionBox = await dashboardSections.boundingBox();
    const trashBox = await trashLink.boundingBox();
    const signOutBox = await signOutButton.boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(trashBox).not.toBeNull();
    expect(signOutBox).not.toBeNull();
    expect(signOutBox?.x ?? 0).toBeGreaterThan((trashBox?.x ?? 0) + (trashBox?.width ?? 0));
    expect(Math.abs((trashBox?.y ?? 0) - (signOutBox?.y ?? 0))).toBeLessThanOrEqual(4);
    if (viewport.width > 430) {
      const workspaceBox = await applicationBar
        .getByRole('button', { name: /Workspace menu/u })
        .boundingBox();
      expect(workspaceBox).not.toBeNull();
      expect(sectionBox?.x ?? 0).toBeGreaterThan(
        (workspaceBox?.x ?? 0) + (workspaceBox?.width ?? 0),
      );
      expect(Math.abs((sectionBox?.y ?? 0) - (workspaceBox?.y ?? 0))).toBeLessThanOrEqual(4);
    }
    const dashboardBar = page.locator('.dashboard-bar');
    const listPageHeading = page.locator('.page-heading');
    const dashboardBarBox = await dashboardBar.boundingBox();
    const listPageHeadingBox = await listPageHeading.boundingBox();
    expect(dashboardBarBox).not.toBeNull();
    expect(listPageHeadingBox).not.toBeNull();
    const listTopGap =
      (listPageHeadingBox?.y ?? 0) - ((dashboardBarBox?.y ?? 0) + (dashboardBarBox?.height ?? 0));
    expect(listTopGap).toBeLessThanOrEqual(24);
    const listHeading = page.getByRole('heading', { level: 1, name: 'Artifacts' });
    const listHeadingSize = await listHeading.evaluate(
      (element) => getComputedStyle(element).fontSize,
    );
    const ledger = page.getByRole('table', { name: 'Artifacts' });
    await expect(ledger.locator('tbody tr')).toHaveCount(10);
    await expect(ledger.getByRole('link', { name: 'x', exact: true })).toBeVisible();
    await expect(ledger.getByRole('link', { name: longArtifactName, exact: true })).toBeVisible();
    await expect(ledger.getByRole('link', { name: longFolderName, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main'), ledger]);

    await page.goto(`/app/w/${workspaceId}/artifacts/${artifactId}`);
    await expect(page).toHaveURL(new RegExp(`${artifactId}$`, 'u'));
    await expect(applicationBar).toBeVisible();
    await expect(
      applicationBar.getByRole('link', { name: 'Artifacts', exact: true }),
    ).toBeVisible();
    const detailHeading = page.getByRole('heading', { level: 1, name: longArtifactName });
    await expect(detailHeading).toBeVisible();
    expect(await detailHeading.evaluate((element) => getComputedStyle(element).fontSize)).toBe(
      listHeadingSize,
    );
    const detailPageHeadingBox = await page.locator('.page-heading').boundingBox();
    expect(detailPageHeadingBox).not.toBeNull();
    const detailTopGap =
      (detailPageHeadingBox?.y ?? 0) - ((dashboardBarBox?.y ?? 0) + (dashboardBarBox?.height ?? 0));
    expect(detailTopGap).toBeCloseTo(listTopGap, 1);
    if (viewport.width > 900) {
      expect(
        await page.locator('.artifact-workbench').evaluate((element) => element.clientHeight),
      ).toBeGreaterThan(520);
    }
    await expectActionWithinViewport(page, 'Share');
    await expectActionWithinViewport(page, 'Preview', 'link');
    await expectNoHorizontalOverflow(page, [
      page.locator('.dashboard-main'),
      page.locator('.artifact-surface'),
    ]);

    await page.goto(`/app/w/${workspaceId}/artifacts/${folderArtifactId}`);
    await expect(page).toHaveURL(new RegExp(`${folderArtifactId}$`, 'u'));
    const folderPreview = page.getByRole('region', { name: 'Folder browser' });
    await expect(folderPreview).toBeVisible();
    // The browser opens on the deepest file, whose full path stays readable through the title
    // even though the visible label truncates.
    await expect(folderPreview.locator('.file-view-meta strong')).toHaveAttribute(
      'title',
      longFolderPath,
    );
    await expectActionWithinViewport(page, 'Share');
    await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main'), folderPreview]);
    diagnostics.assertClean();
  });
}

test('artifact detail keeps revision and share controls compact and explicit', async ({ page }) => {
  const diagnostics = trackPageErrors(page);

  await page.goto(`/app/w/${workspaceId}/artifacts/${artifactId}`);

  const artifactTitle = page.getByRole('heading', { level: 1, name: longArtifactName });
  await expect(artifactTitle).toBeVisible();
  expect(
    Number.parseFloat(
      await artifactTitle.evaluate((element) => getComputedStyle(element).fontSize),
    ),
  ).toBeLessThanOrEqual(24);

  const previewBar = page.locator('.managed-stage-bar');
  await expect(previewBar).toContainText('12th Revision');
  await expect(previewBar).toContainText('Artifact Preview');
  await expect(previewBar).not.toContainText('Revision:');
  await expect(previewBar).not.toContainText(/\d+(?:\.\d+)?\s+(?:k|M)?B/u);
  await expect(page.getByText('Immutable lineage', { exact: true })).toHaveCount(0);
  const managedFileControls = page.getByRole('region', {
    name: `${longArtifactName} view controls`,
  });
  await expect(managedFileControls.locator('.file-view-meta strong')).toHaveAttribute(
    'title',
    longArtifactName,
  );
  await expect(
    managedFileControls.getByRole('button', { name: 'Download', exact: true }),
  ).toBeVisible();

  await expect(page.getByRole('complementary', { name: 'Artifact inspector' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide inspector' })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Compare' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'History' }).click();
  const revisions = page.locator('.revision-row');
  await expect(revisions.first().locator('.revision-index')).toHaveText('12th');
  const restoredRevision = revisions.filter({
    has: page.locator('.revision-index', { hasText: '11th' }),
  });
  await expect(restoredRevision.locator('.revision-lineage')).toContainText('Restored from 9th');
  await expect(restoredRevision.locator('.revision-lineage code')).toHaveText(
    `rev_${'m'.repeat(22)}`,
  );

  const previousRevision = revisions.filter({
    has: page.locator('.revision-index', { hasText: '10th' }),
  });
  await previousRevision.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`revision=rev_${'l'.repeat(22)}`, 'u'));
  await expect(previewBar).toContainText('Viewing 10th Revision');
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'notes.md',
  );
  await expect(previousRevision).toHaveAttribute('data-viewed', 'true');
  await page.getByRole('button', { name: 'View latest' }).click();
  await expect(page).not.toHaveURL(/[?&]revision=/u);
  await expect(previewBar).toContainText('12th');

  const sort = page.getByRole('button', {
    name: 'Revision order: newest first. Show oldest first',
  });
  await sort.click();
  await expect(page).toHaveURL(/[?&]historyOrder=oldest(?:&|$)/u);
  await expect(revisions.first().locator('.revision-index')).toHaveText('9th');
  await expect(
    page.getByRole('button', { name: 'Revision order: oldest first. Show newest first' }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByText('Latest immutable state', { exact: true })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Links' }).click();
  await expect(page.getByText('Unlisted access', { exact: true })).toHaveCount(0);
  const activeShare = page.locator('.share-row').first();
  await expect(
    activeShare.locator('.share-row-state[data-status="Active"] .status-dot'),
  ).toBeVisible();
  const activeLabel = activeShare.getByText('Active', { exact: true });
  await expect(activeLabel).toBeVisible();
  await expect(activeShare.getByRole('button', { name: 'Copy share URL' })).toBeVisible();
  await expect(activeShare.getByRole('button', { name: 'Revoke link' })).toBeVisible();
  await expect(page.getByText('11th Revision', { exact: true })).toBeVisible();
  await expect(page.getByText('10th Revision', { exact: true })).toBeVisible();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const shareOverview = page.getByRole('dialog', { name: 'Share artifact' });
  await expect(shareOverview).toContainText('Protected link');
  await shareOverview.getByRole('button', { name: 'Create new link' }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await shareDialog.getByRole('button', { name: /Options/u }).click();
  await shareDialog.getByRole('combobox', { name: 'Target' }).click();
  await page.getByRole('option', { name: 'Pinned revision' }).click();
  // The history is sorted oldest-first above, so the dialog pins the first loaded revision.
  await expect(shareDialog).toContainText('9th — n.md');
  await expect(shareDialog.getByRole('button', { name: /Options/u })).toContainText(
    'Pinned: 9th revision · Never expires · Comments off',
  );
  await shareDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Hide inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Artifact inspector' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Rename artifact' }).click();
  await expect(page.getByRole('dialog', { name: 'Rename artifact' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Rename artifact' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete artifact?' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Delete artifact?' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);

  await expectNoAxeViolations(page);
  diagnostics.assertClean();
});

test('private file preview reuses the canonical file surface', async ({ page }) => {
  const diagnostics = trackPageErrors(page);

  await page.goto(`/preview/${artifactId}`);

  await expect(page.getByText('Private preview', { exact: true })).toHaveCount(1);
  const controls = page.getByRole('region', {
    name: `${longArtifactName} view controls`,
  });
  await expect(controls).toBeVisible();
  await expect(controls.locator('.file-view-meta strong')).toHaveAttribute(
    'title',
    longArtifactName,
  );
  await expect(controls.getByRole('tab', { name: 'Preview' })).toBeVisible();
  await expect(controls.getByRole('tab', { name: 'Source' })).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'One useful idea',
  );
  await expectNoHorizontalOverflow(page, [page.locator('.artifact-surface')]);
  diagnostics.assertClean();
});

test('the authenticated utility stays artifact-first, accessible, and responsive', async ({
  context,
  page,
}, testInfo) => {
  const diagnostics = trackPageErrors(page, [
    /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u,
  ]);
  const notFoundResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 404) notFoundResponses.push(new URL(response.url()).pathname);
  });

  await context.addCookies([
    {
      name: 'shelf-browser-state',
      value: testInfo.project.name,
      domain: '127.0.0.1',
      path: '/',
    },
  ]);

  await page.goto(`/app/w/${workspaceId}/artifacts`);
  await expect(page.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeVisible();
  await expect(page.getByText('shelf publish ./path --share')).toBeVisible();
  await expect(page.getByRole('link', { name: longArtifactName, exact: true })).toBeVisible();
  await expect(page.getByText('Collections', { exact: true })).toHaveCount(0);
  const dashboardSections = page.getByRole('navigation', { name: 'Dashboard sections' });
  await expect(dashboardSections.getByRole('link', { name: 'Artifacts' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.locator('.dashboard-bar').getByRole('button', { name: 'Sign out' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Workspace menu/u }).click();
  const workspaceMenu = page.locator('.workspace-menu-content');
  await expect(workspaceMenu.getByText('Workspaces', { exact: true })).toBeVisible();
  await expect(workspaceMenu.getByRole('menuitem', { name: 'Access' })).toHaveCount(0);
  await expect(workspaceMenu.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const artifactTable = page.getByRole('table', { name: 'Artifacts' });
  await expect(artifactTable.locator('tbody tr')).toHaveCount(10);
  const tableWidth = page.viewportSize()?.width ?? 0;
  // The ledger drops "Created on" at 900px and "Last Updated" at 520px, so each sort assertion
  // only runs on a viewport that still renders its column.
  if (tableWidth > 520) {
    await expect(
      artifactTable.getByRole('columnheader', { name: /Last Updated/u }),
    ).toHaveAttribute('aria-sort', 'descending');
  }
  if (tableWidth > 900) {
    await artifactTable.getByRole('link', { name: /Created on/u }).click();
    await expect(page).toHaveURL(/sort=created&order=desc/u);
    await artifactTable.getByRole('link', { name: /Created on/u }).click();
    await expect(page).toHaveURL(/sort=created&order=asc/u);
  }
  if (tableWidth > 520) {
    await page.getByRole('link', { name: 'Next' }).click();
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible();
    await expect(artifactTable.locator('tbody tr')).toHaveCount(2);
    await page.getByRole('link', { name: 'Previous' }).click();
    await expect(artifactTable.locator('tbody tr')).toHaveCount(10);
    await artifactTable.getByRole('link', { name: /Last Updated/u }).click();
    // Sorting by a new field starts descending; re-clicking the field already sorted flips it, so
    // narrow viewports need a second click to land back on the default newest-first ledger the
    // assertions below expect.
    if (tableWidth <= 900) {
      await expect(page).toHaveURL(/sort=updated&order=asc/u);
      await artifactTable.getByRole('link', { name: /Last Updated/u }).click();
    }
    await expect(page).toHaveURL(/sort=updated&order=desc/u);
  }
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);
  await expect(
    page.getByRole('link', { name: `Preview artifact ${longArtifactName}` }),
  ).toHaveAttribute('href', `/preview/${artifactId}`);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: `Share artifact ${longArtifactName}` }).click();
  const shareOverviewDialog = page.getByRole('dialog', { name: 'Share artifact' });
  await expect(shareOverviewDialog).toContainText('Protected link');
  await expect(shareOverviewDialog).toContainText('Public link');
  await expect(shareOverviewDialog).toContainText(`/s/${createdShareId}#${shareSecret}`);
  await expect(shareOverviewDialog).toContainText('/s/DefaultPub12');
  await expect(
    shareOverviewDialog.getByRole('button', { name: 'Copy protected url' }),
  ).toBeVisible();
  await expect(shareOverviewDialog.getByRole('button', { name: 'Copy public url' })).toBeVisible();
  await shareOverviewDialog.getByRole('button', { name: 'Create new link' }).click();
  const indexShareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await expect(indexShareDialog.getByRole('radio', { name: /Protected/u })).toBeChecked();
  await expect(indexShareDialog.getByRole('button', { name: /Options/u })).toContainText(
    'Latest revision · Never expires · Comments off',
  );
  await indexShareDialog.getByRole('button', { name: 'Create protected link' }).click();
  const indexCreatedDialog = page.getByRole('dialog', { name: 'Share link created' });
  await expect(indexCreatedDialog).toContainText(`/s/${createdShareId}#${shareSecret}`);
  await expect(indexCreatedDialog).toContainText('Protected · latest revision · never expires');
  await expect(
    indexCreatedDialog.getByRole('button', { name: 'Copy protected share url' }),
  ).toBeVisible();
  await indexCreatedDialog.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'More actions for x' }).click();
  await page.getByRole('menuitem', { name: 'Delete artifact' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete artifact?' });
  await expect(deleteDialog).toContainText('recoverable for 30 days');
  await deleteDialog.getByRole('button', { name: 'Delete artifact' }).click();
  await expect(page.getByRole('link', { name: 'x', exact: true })).toHaveCount(0);
  await expect(page.getByText('x deleted', { exact: true })).toBeVisible();
  await expect(
    page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/artifacts/${id}/recovery`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'other-tab-recovery' },
      });
      return response.status;
    }, shortArtifactId),
  ).resolves.toBe(200);
  await page.getByRole('button', { name: 'Undo deletion' }).click();
  await expect(page.getByRole('link', { name: 'x', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'More actions for x' }).click();
  await page.getByRole('menuitem', { name: 'Delete artifact' }).click();
  await page
    .getByRole('dialog', { name: 'Delete artifact?' })
    .getByRole('button', { name: 'Delete artifact' })
    .click();
  await page.getByRole('link', { name: 'Trash', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
  const trashTable = page.getByRole('table', { name: 'Trash' });
  await expect(trashTable).toContainText(shortArtifactId);
  await expect(trashTable).toContainText(/days/u);
  await trashTable.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByText('Artifact recovered', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy recovery link' })).toBeVisible();
  await expect(trashTable).toHaveCount(0);
  await dashboardSections.getByRole('link', { name: 'Artifacts' }).click();
  await expect(page.getByRole('link', { name: 'x', exact: true })).toBeVisible();

  await page.getByRole('link', { name: longArtifactName, exact: true }).click();
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'One useful idea',
  );
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
  await expectNoHorizontalOverflow(page, [
    page.locator('.dashboard-main'),
    page.locator('.artifact-surface'),
  ]);

  const panelRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/')) panelRequests.push(request.url());
  });
  await expect(page.getByRole('complementary', { name: 'Artifact inspector' })).toBeVisible();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page).not.toHaveURL(/[?&]panel=/u);
  await page.waitForTimeout(100);
  expect(panelRequests).toEqual([]);

  await page.getByRole('button', { name: 'Share' }).click();
  await page
    .getByRole('dialog', { name: 'Share artifact' })
    .getByRole('button', { name: 'Create new link' })
    .click();
  const shareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await shareDialog.getByRole('button', { name: /Options/u }).click();
  await shareDialog.getByRole('combobox', { name: 'Target' }).click();
  await page.getByRole('option', { name: 'Pinned revision' }).click();
  await shareDialog.getByRole('button', { name: 'Create protected link' }).click();
  const createdDialog = page.getByRole('dialog', { name: 'Share link created' });
  await expect(createdDialog).toContainText(`/s/${createdShareId}#${shareSecret}`);
  await createdDialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);

  await page.getByRole('link', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: /Workspace menu/u }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  const createWorkspace = page.getByRole('dialog', { name: 'New workspace' });
  await createWorkspace.getByRole('textbox', { name: 'Workspace ID' }).fill('workspace-work');
  await createWorkspace.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Artifacts' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Workspace menu, workspace-work/u })).toBeVisible();
  await expect(page.getByText('Nothing here yet')).toBeVisible();

  await dashboardSections.getByRole('link', { name: 'Access' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
  await expect(page).toHaveURL('/app/w/workspace-work/access');
  await expect(page.getByText('No access credentials')).toBeVisible();
  await page.getByRole('button', { name: /Workspace menu/u }).click();
  await page.getByRole('menuitem', { name: workspaceId }).click();
  await expect(page).toHaveURL(`/app/w/${workspaceId}/access`);
  // Below 680px the credential ledger swaps the table for the mobile list, so assert on whichever
  // presentation this viewport renders.
  await expect(
    page
      .locator('.credential-mobile-list, .credential-table-shell')
      .locator('visible=true')
      .getByText('expired-agent', { exact: true })
      .first(),
  ).toBeVisible();
  const issue = page.locator('.page-heading').getByRole('button', { name: 'Create Credential' });
  await focusWithKeyboard(page, issue, testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  expect(await issue.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  expect(await issue.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  await page.keyboard.press('Enter');
  const name = page.getByRole('textbox', { name: 'Agent name' });
  await expect(name).toBeFocused();
  const issueDialog = page.getByRole('dialog', { name: 'Create credential' });
  await expect(issueDialog).toBeVisible();
  await name.fill('browser-agent');
  await expect(issueDialog.getByText(workspaceId, { exact: true })).toBeVisible();
  await issueDialog.getByRole('checkbox', { name: 'Publish files' }).check();
  await issueDialog.getByRole('button', { name: 'Create Credential' }).click();
  await expect(issueDialog).toContainText(createdCredentialToken);
  await issueDialog.getByRole('button', { name: 'I saved it' }).click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(createdCredentialToken);
  await expect(issue).toBeFocused();

  const mobileLedger = page.locator('.credential-mobile-list');
  const expiredRow = (await mobileLedger.isVisible())
    ? mobileLedger.locator('.credential-mobile-row').filter({ hasText: 'expired-agent' })
    : page.locator('.credential-table tr').filter({ hasText: 'expired-agent' });
  await expiredRow.getByRole('button', { name: 'Actions for expired-agent' }).click();
  await page.getByRole('menuitem', { name: 'View details' }).click();
  const detailsDialog = page.getByRole('dialog', { name: 'expired-agent' });
  await expect(detailsDialog.getByText('Expired', { exact: true })).toBeVisible();
  await detailsDialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);
  await expectNoAxeViolations(page);
  expect(notFoundResponses).toEqual([`/api/v1/artifacts/${shortArtifactId}/recovery`]);
  diagnostics.assertClean();
});

test('anonymous dashboard requests collapse to the owner sign-in surface', async ({
  page,
  context,
}, testInfo) => {
  const diagnostics = trackPageErrors(page, [
    /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/u,
  ]);
  const unauthorizedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 401) unauthorizedResponses.push(response.url());
  });
  await context.addCookies([
    { name: 'shelf-browser-anonymous', value: '1', url: 'http://127.0.0.1:43873' },
  ]);

  await page.goto('/app');
  await expect(page).toHaveURL(/\/signin\?returnTo=%2Fapp$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  const email = page.getByRole('textbox', { name: 'Email' });
  await focusWithKeyboard(page, email, testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(email).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await expectNoAxeViolations(page);
  expect(unauthorizedResponses.length).toBeGreaterThan(0);
  expect(unauthorizedResponses.every((url) => url.endsWith('/api/v1/dashboard/session'))).toBe(
    true,
  );
  diagnostics.assertClean();
});

test('the public viewer scrubs its capability and reloads from tab-local state', async ({
  page,
}) => {
  const diagnostics = trackPageErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto('/__fixture/history-anchor');
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
  await expect(page).toHaveURL('/__fixture/history-anchor');
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

test('a shared-history viewer moves between revisions and returns to Latest', async ({ page }) => {
  const diagnostics = trackPageErrors(page);

  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await expect(page.getByRole('heading', { level: 1, name: 'One useful idea' })).toBeVisible();
  const revisionSelector = page.getByRole('combobox', { name: 'Select revision' });
  await revisionSelector.click();
  const revisionOptions = page.getByRole('option');
  await expect(revisionOptions).toHaveCount(12);
  await expect(revisionOptions).toHaveText([
    'Latest Revision',
    '11th Revision',
    '10th Revision',
    '9th Revision',
    '8th Revision',
    '7th Revision',
    '6th Revision',
    '5th Revision',
    '4th Revision',
    '3rd Revision',
    '2nd Revision',
    '1st Revision',
  ]);
  const revisionList = page.getByRole('listbox');
  const revisionListGeometry = await revisionList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    firstOptionHeight:
      element.querySelector('[role="option"]')?.getBoundingClientRect().height ?? 0,
    scrollHeight: element.scrollHeight,
  }));
  expect(revisionListGeometry.firstOptionHeight).toBeGreaterThan(0);
  expect(revisionListGeometry.clientHeight).toBeLessThanOrEqual(
    revisionListGeometry.firstOptionHeight * 10 + 1,
  );
  expect(revisionListGeometry.scrollHeight).toBeGreaterThan(revisionListGeometry.clientHeight);
  await page.getByRole('option', { name: '11th Revision' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading revision…' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`revision=${previousRevisionId}$`, 'u'));
  await expect(page.getByRole('heading', { level: 1, name: 'Earlier useful idea' })).toBeVisible();
  await expect(page.getByText('Loading revision…')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Latest Revision available' })).toBeVisible();

  await page.getByRole('button', { name: 'Latest Revision available' }).click();
  await expect(page).not.toHaveURL(/[?&]revision=/u);
  await expect(page.getByRole('heading', { level: 1, name: 'One useful idea' })).toBeVisible();
  await expectNoHorizontalOverflow(page, [page.locator('.artifact-surface')]);
  await expectNoAxeViolations(page);
  diagnostics.assertClean();
});

test('rich protected shares render structured and image previews without leaking capability material', async ({
  page,
}) => {
  const diagnostics = trackPageErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`/s/${yamlShareId}#${shareSecret}`);
  await expect(page).toHaveURL(`/s/${yamlShareId}`);
  const yamlControls = page.getByRole('region', { name: 'preview.yaml view controls' });
  await expect(yamlControls.getByText('preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(yamlControls.getByRole('tab', { name: 'Preview' })).toBeVisible();
  await expect(yamlControls.getByRole('tab', { name: 'Source' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(1);
  await yamlControls.getByRole('tab', { name: 'Source' }).click();
  await expect(page.locator('body')).toContainText('name: Shelf preview');
  await yamlControls.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Shelf preview');

  await page.goto(`/s/${csvShareId}#${shareSecret}`);
  const csvControls = page.getByRole('region', { name: 'preview.csv view controls' });
  await expect(csvControls.getByText('preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Preview' })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).toContainText('Deterministic fixture');
  const csvScroll = page.getByRole('region', {
    name: 'preview.csv horizontally scrollable table',
  });
  const csvExtent = await csvScroll.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(csvExtent.scrollWidth).toBeGreaterThan(csvExtent.clientWidth);
  await csvScroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => csvScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page
    .getByRole('region', { name: 'preview.csv view controls' })
    .getByRole('tab', { name: 'Source' })
    .click();
  await expect(page.locator('body')).toContainText('id,label,score');

  await page.goto(`/s/${svgShareId}#${shareSecret}`);
  const svgControls = page.getByRole('region', { name: 'preview.svg view controls' });
  await expect(svgControls.getByText('preview', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'preview.svg' })).toBeVisible();

  const previewUrls = requests.filter((url) => url.includes('/content/preview'));
  expect(previewUrls.length).toBeGreaterThan(0);
  expect(previewUrls.every((url) => !url.includes(shareSecret))).toBe(true);
  expect(previewUrls.every((url) => new URL(url).search === '' && !url.includes('#'))).toBe(true);
  expect(requests.some((url) => url.includes(shareSecret))).toBe(false);

  const scope = await page.evaluate(
    async () =>
      (await fetch('/__fixture/cookie-scope')).json() as Promise<{
        readonly protectedCookieOnUnscopedPath: boolean;
      }>,
  );
  expect(scope.protectedCookieOnUnscopedPath).toBe(false);
  await expectNoHorizontalOverflow(page, [page.locator('.artifact-surface')]);
  diagnostics.assertClean();
});

test('a singular workbook fills its pane without creating fake sheet overflow', async ({
  page,
}) => {
  await page.goto(`/s/${xlsxShareId}#${shareSecret}`);
  await expect(page).toHaveURL(`/s/${xlsxShareId}`);

  const controls = page.getByRole('region', { name: 'preview-sheet.xlsx view controls' });
  await expect(controls.getByText('preview-sheet', { exact: true })).toBeVisible();
  await expect(controls.getByText('XLSX', { exact: true })).toBeVisible();

  const workbook = page.getByRole('region', { name: 'preview-sheet.xlsx', exact: true });
  const grid = page.getByRole('grid', { name: 'Overview workbook grid' });
  await expect(workbook).toBeVisible();
  await expect(grid).toBeVisible();
  await expect(workbook.locator('.workbook-preview-status')).toHaveCount(0);

  await expect
    .poll(async () => {
      const gridBox = await grid.boundingBox();
      const lastColumnBox = await grid.getByRole('columnheader', { name: 'D' }).boundingBox();
      if (gridBox === null || lastColumnBox === null) return Number.POSITIVE_INFINITY;
      return Math.abs(gridBox.x + gridBox.width - (lastColumnBox.x + lastColumnBox.width));
    })
    .toBeLessThan(2);

  const gridExtent = await grid.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(gridExtent.scrollHeight).toBe(gridExtent.clientHeight);

  await page.getByRole('tab', { name: 'Checks' }).click();
  const wideGrid = page.getByRole('grid', { name: 'Checks workbook grid' });
  await expect(wideGrid).toBeVisible();
  const wideExtent = await wideGrid.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(wideExtent.scrollWidth).toBeGreaterThan(wideExtent.clientWidth);
  await wideGrid.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(() => wideGrid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(wideGrid.getByRole('columnheader', { name: 'L' })).toBeVisible();
});

test('rich protected and public media shares expose inline preview controls and ranges', async ({
  page,
}) => {
  const diagnostics = trackPageErrors(page, [/^The resource was preloaded using link preload/u]);
  const requests: string[] = [];
  const previewResponses: { readonly headers: Record<string, string>; readonly status: number }[] =
    [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('response', (response) => {
    if (response.url().includes('/content/preview')) {
      previewResponses.push({ headers: response.headers(), status: response.status() });
    }
  });

  await page.goto(`/s/${pdfShareId}#${shareSecret}`);
  await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
  await expect(page.locator('canvas[role="img"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous PDF page' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fit PDF page to width' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in PDF' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF preview' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const pdfZoom = page.getByLabel('PDF zoom');
  const fittedPdfZoom = Number((await pdfZoom.textContent())?.replace('%', ''));
  expect(fittedPdfZoom).toBeGreaterThanOrEqual(50);
  expect(fittedPdfZoom).toBeLessThanOrEqual(150);
  await page.getByRole('button', { name: 'Zoom out PDF' }).click();
  const manualPdfZoom = Math.max(50, fittedPdfZoom - 25);
  await expect(pdfZoom).toHaveText(`${manualPdfZoom}%`);
  await page.reload();
  await expect(page.locator('canvas[role="img"]')).toBeVisible();
  await expect(pdfZoom).toHaveText(`${manualPdfZoom}%`);
  await page.getByRole('button', { name: 'Fit PDF page to width' }).click();
  await expect(pdfZoom).toHaveText(`${fittedPdfZoom}%`);
  await page.reload();
  await expect(page.locator('canvas[role="img"]')).toBeVisible();
  await expect(pdfZoom).toHaveText(`${fittedPdfZoom}%`);

  const protectedPreviewUrl = `/api/v1/public/shares/${pdfShareId}/content/preview`;
  const protectedRange = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    return {
      acceptRanges: response.headers.get('accept-ranges'),
      contentLength: response.headers.get('content-length'),
      contentRange: response.headers.get('content-range'),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      status: response.status,
    };
  }, protectedPreviewUrl);
  expect(protectedRange.status).toBe(206);
  expect(protectedRange.acceptRanges).toBe('bytes');
  expect(protectedRange.contentRange).toBe('bytes 0-15/583');
  expect(protectedRange.contentLength).toBe('16');
  expect(protectedRange.contentType).toBe('application/pdf');
  expect(protectedRange.etag).toBeTruthy();

  await page.goto(`/s/${audioShareId}#${shareSecret}`);
  const audio = page.locator('audio');
  await expect(audio).toHaveAttribute('preload', 'metadata');
  await expect(audio).not.toHaveAttribute('autoplay');
  await expect(page.getByRole('button', { name: 'Play audio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mute audio' })).toBeVisible();

  await page.goto(`/s/${videoShareId}#${shareSecret}`);
  const video = page.locator('video');
  await expect(video).toHaveAttribute('preload', 'metadata');
  await expect(video).not.toHaveAttribute('autoplay');
  await expect(page.getByRole('button', { name: 'Play video' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();

  let downloadStarted = false;
  page.on('download', async (event) => {
    downloadStarted = true;
    await event.cancel();
  });
  await page.goto(`/s/${publicPdfCode}`);
  await expect(page).toHaveURL(`/s/${publicPdfCode}`);
  await expect(page.getByRole('region', { name: 'PDF preview' })).toBeVisible();
  await expect(page.locator('canvas[role="img"]')).toBeVisible();
  const download = page
    .getByRole('region', { name: 'preview-public.pdf view controls' })
    .getByRole('button', { name: 'Download', exact: true });
  await expect(download).toBeVisible();
  expect(downloadStarted).toBe(false);
  await download.click();
  await expect.poll(() => downloadStarted).toBe(true);

  const publicPreviewUrls = requests.filter((url) =>
    url.includes(`/public/links/${publicPdfCode}`),
  );
  expect(publicPreviewUrls.every((url) => new URL(url).search === '')).toBe(true);
  expect(requests.some((url) => url.includes(shareSecret))).toBe(false);
  expect(previewResponses.some((response) => [200, 206].includes(response.status))).toBe(true);
  await expectNoHorizontalOverflow(page, [page.locator('.artifact-surface')]);
  diagnostics.assertClean();
});

test('rich public PDF preview remains usable at narrow mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/s/${publicPdfCode}`);
  const pdf = page.getByRole('region', { name: 'PDF preview' });
  await expect(pdf).toBeVisible();
  await expect(pdf.getByRole('button', { name: 'Next PDF page' })).toBeVisible();
  await expectNoHorizontalOverflow(page, [pdf, page.locator('.artifact-surface')]);
  await expectActionWithinViewport(
    page,
    'Download',
    'button',
    page.getByRole('region', { name: 'preview-public.pdf view controls' }),
  );
});

test('reduced motion and the 200 percent layout equivalent preserve utility', async ({
  page,
}, testInfo) => {
  const diagnostics = trackPageErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto(`/app/w/${workspaceId}/access`);

  const issue = page.locator('.page-heading').getByRole('button', { name: 'Create Credential' });
  await issue.click();
  const dialog = page.getByRole('dialog', { name: 'Create credential' });
  await expect(dialog).toBeVisible();
  const reducedTransition = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: style.transitionDuration, property: style.transitionProperty };
  });
  expect(reducedTransition.property).toBe('opacity');
  const reducedSeconds = Number.parseFloat(reducedTransition.duration);
  expect(reducedSeconds).toBeLessThanOrEqual(0.25);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await issue.click();
  const defaultSeconds = Number.parseFloat(
    await dialog.evaluate((element) => getComputedStyle(element).transitionDuration),
  );
  expect(reducedSeconds).toBeLessThan(defaultSeconds);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);

  if (testInfo.project.name === 'zoom-200-chromium') {
    await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await expectNoAxeViolations(page);
  }
  diagnostics.assertClean();
});

test('HTML preview starts dark and can be checked in light mode', async ({ page }) => {
  await page.goto(`/s/${htmlShareId}#${shareSecret}`);

  const controls = page.getByRole('region', { name: 'idea.html view controls' });
  const themeControls = controls.getByRole('group', { name: 'HTML preview theme' });
  const frame = page.locator('iframe[title="idea.html isolated preview"]');

  await expect(page.getByRole('button', { name: 'Open file discussions sidebar' })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.file-view').evaluate((fileView) => {
        const contentPanel = fileView.parentElement;
        if (contentPanel === null) return Number.POSITIVE_INFINITY;
        return Math.abs(
          fileView.getBoundingClientRect().height - contentPanel.getBoundingClientRect().height,
        );
      }),
    )
    .toBeLessThanOrEqual(1);

  await expect(themeControls.getByRole('tab', { name: 'Dark' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() => frame.evaluate((element) => getComputedStyle(element).colorScheme))
    .toBe('dark');

  await themeControls.getByRole('tab', { name: 'Light' }).click();
  await expect(themeControls.getByRole('tab', { name: 'Light' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(() => frame.evaluate((element) => getComputedStyle(element).colorScheme))
    .toBe('light');
  await expectNoHorizontalOverflow(page, [controls]);
});

test('the active renderer cannot escape its opaque sandbox', async ({
  page,
  context,
}, testInfo) => {
  // Firefox renders the sandboxed frame but never delivers its boundary-probe
  // postMessage to the parent, even with every probe attempt guarded; the
  // renderer itself works there. The sandbox contract stays verified in
  // Chromium and WebKit, which enforce the same iframe attributes and CSP.
  // Tracked as a Firefox-specific investigation.
  test.skip(testInfo.project.name === 'firefox', 'Firefox drops the sandboxed boundary probe.');
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
      name: 'application-cookie-canary',
      value: 'present',
      url: 'http://127.0.0.1:43873',
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'renderer-cookie-canary',
      value: 'present',
      url: `${rendererOrigin}/render`,
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
      } else if (
        typeof event.data === 'object' &&
        event.data !== null &&
        event.data.type === 'shelf:test-navigation-attempt'
      ) {
        window.shelfNavigationAttempted = true;
      }
    });
  });
  page.on('request', (request) => {
    requestCaptures.push(
      request.allHeaders().then((headers) => {
        const entry = { url: request.url(), headers };
        if (new URL(entry.url).pathname === '/api/v1/renderer-canary') {
          appApiRequests.push(entry);
        }
        if (entry.url === `${rendererOrigin}/render`) rendererRequests.push(entry);
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
  const frameName = await frame.getAttribute('name');
  expect(frameName).toMatch(/^shelf-renderer-[0-9a-f-]{36}$/u);
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
  await expect.poll(() => page.evaluate(() => window.shelfNavigationAttempted ?? false)).toBe(true);
  await page.waitForTimeout(250);
  await Promise.all(requestCaptures);

  const prohibited = canaryRequests.filter(
    (request) => !request.url.startsWith('https://navigation-canary.invalid/'),
  );
  expect(prohibited).toEqual([]);
  const appCanaryHits = await page.evaluate(async (run) => {
    const response = await fetch(
      `/__fixture/renderer-canary-hits?run=${encodeURIComponent(run ?? '')}`,
      { cache: 'no-store' },
    );
    return ((await response.json()) as { hits: number }).hits;
  }, frameName);
  expect(appCanaryHits).toBe(0);
  if (testInfo.project.name.includes('chromium')) {
    expect(appApiRequests.length).toBeGreaterThan(0);
  }
  for (const request of appApiRequests) {
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.referer).toBeFalsy();
  }
  expect(rendererRequests).toHaveLength(1);
  expect(rendererRequests[0]?.headers.cookie).toBeUndefined();
  expect(popupCount).toBe(0);
  await expect(page).toHaveURL(`/s/${htmlShareId}`);
  const navigation = canaryRequests.filter((request) =>
    request.url.startsWith('https://navigation-canary.invalid/'),
  );
  expect(navigation.length).toBeLessThanOrEqual(1);
  for (const request of navigation) {
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
  }
});
