import { expect, type Locator, type Page, test } from '@playwright/test';
import type axe from 'axe-core';
import type { AxeResults } from 'axe-core';

import {
  artifactId,
  createdCredentialToken,
  createdShareId,
  folderArtifactId,
  htmlShareId,
  longArtifactName,
  longFolderName,
  longFolderPath,
  markdownShareId,
  rendererOrigin,
  shareSecret,
  shortArtifactId,
  workspaceId,
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

async function expectActionWithinViewport(page: Page, name: string): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const action = page.getByRole('button', { name, exact: true });
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
    const applicationBar = page.getByRole('navigation', { name: 'Current location' });
    await expect(applicationBar).toBeVisible();
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
    await expect(ledger.locator('tbody tr')).toHaveCount(5);
    await expect(ledger.getByText('x', { exact: true })).toBeVisible();
    await expect(ledger.getByText(longArtifactName, { exact: true })).toBeVisible();
    await expect(ledger.getByText(longFolderName, { exact: true })).toBeVisible();
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
    await expectNoHorizontalOverflow(page, [
      page.locator('.dashboard-main'),
      page.locator('.artifact-surface'),
    ]);

    await page.goto(`/app/w/${workspaceId}/artifacts/${folderArtifactId}`);
    await expect(page).toHaveURL(new RegExp(`${folderArtifactId}$`, 'u'));
    const folderPreview = page.getByRole('region', { name: 'Artifact folder preview' });
    await expect(
      folderPreview.locator('.tree-name').filter({ hasText: 'manifest.json' }),
    ).toHaveAttribute('title', longFolderPath);
    await expectActionWithinViewport(page, 'Share');
    await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main'), folderPreview]);
    diagnostics.assertClean();
  });
}

test('artifact detail keeps revision and share controls compact and explicit', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'The focused workbench interaction runs once.');
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
  await expect(previewBar).toContainText('12th');
  await expect(previewBar).not.toContainText('Revision:');
  await expect(previewBar).not.toContainText(longArtifactName);
  await expect(previewBar).not.toContainText(/\d+(?:\.\d+)?\s+(?:k|M)?B/u);
  await expect(page.getByText('Immutable lineage', { exact: true })).toHaveCount(0);

  await expect(page.getByRole('complementary', { name: 'Artifact inspector' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await expect(page.getByRole('complementary', { name: 'Artifact inspector' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Compare' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'History' }).click();
  const revisions = page.locator('.revision-row');
  await expect(revisions.first().locator('.revision-index')).toHaveText('12th');
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
    activeShare.locator('.share-row-state[data-active="true"] .status-dot'),
  ).toBeVisible();
  const activeLabel = activeShare.getByText('Active', { exact: true });
  await expect(activeLabel).toBeVisible();
  await expect(activeShare.getByRole('button', { name: 'Revoke link' })).toBeVisible();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await shareDialog.getByRole('radio', { name: /Pinned/u }).click();
  await expect(shareDialog).toContainText(`12th — ${longArtifactName}`);
  await shareDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.shelf-dialog')).toHaveCount(0);

  await page
    .getByRole('complementary', { name: 'Artifact inspector' })
    .getByRole('button', { name: 'Hide inspector' })
    .click();
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
  await expect(page.getByRole('link', { name: longArtifactName })).toBeVisible();
  await expect(page.getByText('Collections', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, [page.locator('.dashboard-main')]);
  await expectNoAxeViolations(page);

  await page.getByRole('button', { name: `Share artifact ${longArtifactName}` }).click();
  const indexShareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await expect(indexShareDialog.getByRole('radio', { name: /Latest/u })).toBeChecked();
  await expect(indexShareDialog.getByLabel('Expires')).toHaveValue('');
  await indexShareDialog.getByRole('button', { name: 'Create link' }).click();
  await expect(indexShareDialog).toContainText(`/s/${createdShareId}#${shareSecret}`);
  await expect(indexShareDialog.getByRole('button', { name: 'Copy share url' })).toBeVisible();
  await indexShareDialog.getByRole('button', { name: 'Done' }).click();

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
  await page.getByRole('button', { name: 'Undo deletion' }).click();
  await expect(page.getByRole('link', { name: 'x', exact: true })).toBeVisible();

  await page.getByRole('link', { name: longArtifactName }).click();
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
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page).not.toHaveURL(/[?&]panel=/u);
  await page.waitForTimeout(100);
  expect(panelRequests).toEqual([]);

  await page.getByRole('button', { name: 'Share' }).click();
  const shareDialog = page.getByRole('dialog', { name: 'Create share link' });
  await shareDialog.getByRole('radio', { name: /Pinned/u }).click();
  await shareDialog.getByRole('button', { name: 'Create link' }).click();
  await expect(shareDialog).toContainText(`/s/${createdShareId}#${shareSecret}`);
  await shareDialog.getByRole('button', { name: 'Done' }).click();
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

  await page.getByRole('button', { name: /Workspace menu/u }).click();
  await page.getByRole('menuitem', { name: 'Access' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Access' })).toBeVisible();
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
  await issueDialog.getByRole('checkbox', { name: 'file.publish' }).first().check();
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

test('reduced motion and the 200 percent layout equivalent preserve utility', async ({
  page,
}, testInfo) => {
  const diagnostics = trackPageErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/app/access');

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
    await expect(page.getByRole('navigation', { name: 'Current location' })).toBeVisible();
    await expectNoAxeViolations(page);
  }
  diagnostics.assertClean();
});

test('the active renderer cannot escape its opaque sandbox', async ({
  page,
  context,
}, testInfo) => {
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
