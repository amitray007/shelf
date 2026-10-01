import { expect, test } from '@playwright/test';

import {
  audioShareId,
  csvShareId,
  docxShareId,
  htmlShareId,
  markdownShareId,
  pdfShareId,
  shareSecret,
  svgShareId,
  videoShareId,
  xlsxShareId,
  yamlShareId,
} from './fixtures.js';

for (const [format, shareId, content, options] of [
  ['Markdown', markdownShareId, '.markdown-body', null],
  ['HTML', htmlShareId, 'iframe', null],
  ['YAML', yamlShareId, '.structured-tree', '.structured-data-filter'],
  ['CSV', csvShareId, '.delimited-table', '.delimited-table-search'],
  ['Workbook', xlsxShareId, '[role="grid"]', '.workbook-preview-tabs'],
  ['PDF', pdfShareId, 'canvas[role="img"]', '.pdf-viewer-toolbar'],
  ['Word', docxShareId, '.office-docx-page', '.office-docx-toolbar'],
  ['Image', svgShareId, 'img', null],
  ['Audio', audioShareId, 'audio', null],
  ['Video', videoShareId, 'video', null],
] as const) {
  test(`${format} floating actions fit desktop and narrow panels`, async ({ page }, testInfo) => {
    await page.goto(`/s/${shareId}#${shareSecret}`);
    await expect(page.locator(content).first()).toBeAttached();
    await page.getByRole('button', { name: 'Open artifact details' }).click();
    const panel = page.getByRole('dialog', { name: 'Artifact details' });
    await panel.getByRole('tab', { name: 'View & actions' }).click();
    await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    if (options === null) {
      await expect(panel.locator('.viewer-renderer-section')).toBeHidden();
    } else {
      await expect(panel.locator(options)).toBeVisible();
    }
    await expect(page.getByText('Use Page Up and Page Down', { exact: false })).toHaveCount(0);
    await expect(
      page.getByText('Values and formulas are displayed as inert text.', { exact: false }),
    ).toHaveCount(0);

    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const body = panel.locator('.viewer-actions-body');
      await expect
        .poll(() => body.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
      for (const selector of [
        '.viewer-revision-navigation > .target-state',
        '.structured-data-filter',
        '.delimited-table-search',
      ]) {
        const control = panel.locator(selector);
        if ((await control.count()) === 0) continue;
        const bounds = await control.evaluate((element) => ({
          control: element.getBoundingClientRect().width,
          section: element.closest('section')?.getBoundingClientRect().width ?? 0,
          clipped: element.scrollWidth > element.clientWidth + 1,
        }));
        expect(bounds.control).toBeCloseTo(bounds.section, 0);
        expect(bounds.clipped).toBe(false);
      }
      if (format === 'YAML' || format === 'CSV') {
        const search = panel.locator(
          format === 'YAML' ? '.structured-data-filter' : '.delimited-table-search',
        );
        const appearance = await search.evaluate((element) => {
          const styles = getComputedStyle(element);
          return { background: styles.backgroundColor, border: styles.borderTopWidth };
        });
        expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
        expect(appearance.border).toBe('1px');
      }
    }
    await page.screenshot({
      path: testInfo.outputPath(`${format.toLowerCase()}-actions-mobile.png`),
    });
  });
}
