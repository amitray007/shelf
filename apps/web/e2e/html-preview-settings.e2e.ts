import { expect, test } from '@playwright/test';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test('an owner saves and clears trusted HTML preview asset sources', async ({
  context,
  page,
}, testInfo) => {
  await context.addCookies([
    {
      name: 'shelf-browser-state',
      value: `html-preview-settings-${testInfo.project.name}`,
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto('/app/settings');
  const textarea = page.getByRole('textbox', { name: 'Trusted asset sources' });
  await expect(textarea).toHaveValue('https://cdn.example.com');
  await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), fullPage: true });
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: 'Artifacts', exact: true })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await textarea.fill('https://assets.example.com\nhttps://fonts.example.com');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(textarea).toHaveValue('https://assets.example.com\nhttps://fonts.example.com');
  await expect(page.getByText(/Trusted asset sources saved/u)).toBeVisible();

  await textarea.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/Trusted asset sources saved/u)).toBeVisible();
  await page.reload();
  await expect(textarea).toHaveValue('');
});

test('the settings page shows save failures and hides settings for non-owners', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'shelf-browser-state', value: 'html-preview-error', domain: '127.0.0.1', path: '/' },
    { name: 'shelf-browser-settings-error', value: '1', domain: '127.0.0.1', path: '/' },
  ]);
  await page.goto('/app/settings');
  await page
    .getByRole('textbox', { name: 'Trusted asset sources' })
    .fill('https://assets.example.com');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Shelf could not save trusted asset sources.');

  await context.clearCookies();
  await context.addCookies([
    { name: 'shelf-browser-non-owner', value: '1', domain: '127.0.0.1', path: '/' },
  ]);
  await page.goto('/app/w/workspace-browser/artifacts');
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
  await page.goto('/app/settings');
  await expect(
    page.getByRole('heading', { name: 'Installation settings are available to owners only.' }),
  ).toBeVisible();
});

test('HTML preview settings are keyboard reachable and do not overflow on mobile', async ({
  context,
  page,
}, testInfo) => {
  await context.addCookies([
    {
      name: 'shelf-browser-state',
      value: `html-preview-keyboard-${testInfo.project.name}`,
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/app/settings');
  const settingsLink = page.getByRole('link', { name: 'Settings', exact: true });
  const tabKey = testInfo.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (
    let index = 0;
    index < 12 && !(await settingsLink.evaluate((element) => element === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press(tabKey);
  }
  await expect(settingsLink).toBeFocused();
  const textarea = page.getByRole('textbox', { name: 'Trusted asset sources' });
  for (
    let index = 0;
    index < 8 && !(await textarea.evaluate((element) => element === document.activeElement));
    index += 1
  ) {
    await page.keyboard.press(tabKey);
  }
  await expect(textarea).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('https://assets.example.com');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeEnabled();
  await page.keyboard.press(tabKey);
  await expect(save).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Trusted asset sources saved/u)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
});
