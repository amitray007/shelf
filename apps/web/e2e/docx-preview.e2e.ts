import { expect, type Page, test } from '@playwright/test';

import { docxShareId, shareSecret, xlsxShareId } from './fixtures.js';

async function expectSafeDocxLayout(page: Page): Promise<void> {
  const preview = page.getByRole('region', { name: 'preview.docx', exact: true });
  const pageCanvas = preview.locator('.office-docx-page');
  const result = await pageCanvas.evaluate((canvas) => {
    const canvasBox = canvas.getBoundingClientRect();
    const blocks = Array.from(canvas.children).map((block) => {
      const element = block as HTMLElement;
      const box = element.getBoundingClientRect();
      return {
        bottom: box.bottom,
        clipped: element.scrollHeight > element.clientHeight + 1,
        left: box.left,
        right: box.right,
        top: box.top,
      };
    });
    return {
      blocks,
      canvas: {
        bottom: canvasBox.bottom,
        left: canvasBox.left,
        right: canvasBox.right,
        scrollHeight: (canvas as HTMLElement).scrollHeight,
        clientHeight: (canvas as HTMLElement).clientHeight,
        scrollWidth: (canvas as HTMLElement).scrollWidth,
        clientWidth: (canvas as HTMLElement).clientWidth,
        top: canvasBox.top,
      },
    };
  });

  expect(result.blocks.length).toBeGreaterThan(8);
  expect(result.canvas.scrollWidth).toBeLessThanOrEqual(result.canvas.clientWidth + 1);
  expect(result.canvas.scrollHeight).toBeLessThanOrEqual(result.canvas.clientHeight + 1);
  for (const block of result.blocks) {
    expect(block.clipped).toBe(false);
    expect(block.left).toBeGreaterThanOrEqual(result.canvas.left - 1);
    expect(block.right).toBeLessThanOrEqual(result.canvas.right + 1);
    expect(block.top).toBeGreaterThanOrEqual(result.canvas.top - 1);
    expect(block.bottom).toBeLessThanOrEqual(result.canvas.bottom + 1);
  }
  for (let index = 1; index < result.blocks.length; index += 1) {
    const block = result.blocks[index];
    const previous = result.blocks[index - 1];
    if (block === undefined || previous === undefined) throw new Error('Missing DOCX block.');
    expect(block.top).toBeGreaterThanOrEqual(previous.bottom - 1);
  }
}

test('DOCX preview keeps wrapped document content visible across layout changes', async ({
  page,
}, testInfo) => {
  const resolveRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/public/shares/${docxShareId}/resolve`)) {
      resolveRequests.push(request.url());
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/s/${docxShareId}#${shareSecret}`);
  const preview = page.getByRole('region', { name: 'preview.docx', exact: true });
  await expect(preview).toHaveAttribute('aria-busy', 'false');
  await expect(
    preview.getByText('DOCX Preview Layout Verification', { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText('Readable headings, wrapped paragraphs, and table content', { exact: true }),
  ).toBeVisible();
  await expect(preview.getByText('Trailing text after one page', { exact: true })).toBeVisible();
  await expect(
    preview.getByText(
      'This final sentence must remain visible after all of the long content above.',
    ),
  ).toBeVisible();
  await expect(preview.locator('.office-docx-table-block')).toBeVisible();

  const pageCanvas = preview.locator('.office-docx-page');
  await expect
    .poll(() => pageCanvas.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(1056);
  await expectSafeDocxLayout(page);
  await page.screenshot({ path: testInfo.outputPath('docx-desktop.png'), fullPage: true });

  const requestsBeforeBackgroundCheck = resolveRequests.length;
  await page.evaluate(() => {
    (
      window as Window & { docxPageBeforeBackgroundCheck?: Element | undefined }
    ).docxPageBeforeBackgroundCheck = document.querySelector('.office-docx-page') ?? undefined;
    window.dispatchEvent(new Event('focus'));
  });
  await expect.poll(() => resolveRequests.length).toBeGreaterThan(requestsBeforeBackgroundCheck);
  await expect(preview).toHaveAttribute('aria-busy', 'false');
  expect(
    await page.evaluate(
      () =>
        (window as Window & { docxPageBeforeBackgroundCheck?: Element | undefined })
          .docxPageBeforeBackgroundCheck === document.querySelector('.office-docx-page'),
    ),
  ).toBe(true);

  const documentBounds = await preview.boundingBox();
  await page.getByRole('button', { name: 'Open artifact details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Artifact details' })).toBeVisible();
  expect(await preview.boundingBox()).toEqual(documentBounds);
  await page.getByRole('button', { name: 'Close artifact details', exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { docxPageBeforeBackgroundCheck?: Element | undefined })
          .docxPageBeforeBackgroundCheck === document.querySelector('.office-docx-page'),
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 320, height: 800 });
  await preview.focus();
  await page.keyboard.press('+');
  await expect(page.getByLabel('DOCX zoom')).toHaveText('125%');
  const zoomedPosition = await preview.locator('.office-docx-page-shell').evaluate((shell) => {
    const canvas = shell.querySelector('.office-docx-page');
    if (canvas === null) throw new Error('Missing DOCX page canvas.');
    shell.scrollLeft = 0;
    const shellBox = shell.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    return { canvasLeft: canvasBox.left, scrollLeft: shell.scrollLeft, shellLeft: shellBox.left };
  });
  expect(zoomedPosition.scrollLeft).toBe(0);
  expect(zoomedPosition.canvasLeft).toBeGreaterThanOrEqual(zoomedPosition.shellLeft + 15);
  await expectSafeDocxLayout(page);
  await page.keyboard.press('0');
  await expect(page.getByLabel('DOCX zoom')).toHaveText('100%');
  await expectSafeDocxLayout(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('docx-narrow.png'), fullPage: true });

  await page.goto(`/s/${xlsxShareId}#${shareSecret}`);
  await expect(page.getByRole('region', { name: 'preview-sheet.xlsx', exact: true })).toBeVisible();
});
