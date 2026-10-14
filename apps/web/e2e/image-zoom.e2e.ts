import { expect, test } from '@playwright/test';

import { shareSecret, svgShareId } from './fixtures.js';

test('images zoom around the clicked point, pan, and return to fit', async ({ page }) => {
  let requests = 0;
  await page.route(`**/api/v1/public/shares/${svgShareId}/content`, async (route) => {
    requests += 1;
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#527ad1"/></svg>',
    });
  });
  await page.goto(`/s/${svgShareId}#${shareSecret}`);
  const target = page.getByRole('button', { name: 'Zoom image in', exact: true });
  const image = page.getByRole('img', { name: 'preview.svg' });
  const canvas = page.getByRole('region', { name: 'Image canvas' });
  const fit = page.getByRole('button', { name: 'Fit image', exact: true });
  const percentage = page.getByLabel('Image zoom', { exact: true });
  await expect(target).toBeEnabled();
  await expect(target).toHaveCSS('cursor', 'zoom-in');
  await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  const bounds = await image.boundingBox();
  if (!bounds) throw new Error('Missing image bounds');
  const point = {
    x: Math.floor(bounds.x + bounds.width * 0.6),
    y: Math.floor(bounds.y + bounds.height * 0.6),
  };
  await page.mouse.click(point.x, point.y);
  await expect(percentage).toHaveText('100%');
  const zoomed = page.getByRole('button', { name: 'Zoom image out to fit', exact: true });
  await expect(zoomed).toHaveCSS('cursor', 'zoom-out');
  const enlarged = await image.boundingBox();
  if (!enlarged) throw new Error('Missing enlarged image bounds');
  expect(enlarged.width).toBe(2400);
  expect(enlarged.height).toBe(1600);
  expect(
    Math.abs(enlarged.x + (enlarged.width * (point.x - bounds.x)) / bounds.width - point.x),
  ).toBeLessThan(2);
  expect(
    Math.abs(enlarged.y + (enlarged.height * (point.y - bounds.y)) / bounds.height - point.y),
  ).toBeLessThan(2);

  const before = await canvas.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  const frame = await canvas.boundingBox();
  if (!frame) throw new Error('Missing canvas bounds');
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 40, center.y - 40, { steps: 4 });
  await expect(zoomed).toHaveCSS('cursor', 'grabbing');
  await page.mouse.up();
  await expect(percentage).toHaveText('100%');
  const after = await canvas.evaluate((element) => ({
    x: element.scrollLeft,
    y: element.scrollTop,
  }));
  expect(after.x - before.x).toBeCloseTo(40, 0);
  expect(after.y - before.y).toBeCloseTo(40, 0);

  await page.mouse.click(center.x, center.y);
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  await expect(target).toHaveCSS('cursor', 'zoom-in');
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect(percentage).toHaveText('100%');
  await canvas.focus();
  await page.keyboard.press('+');
  await expect(percentage).toHaveText('150%');
  await page.keyboard.press('-');
  await expect(percentage).toHaveText('100%');
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('+');
  await expect(percentage).toHaveText('400%');
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(fit).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(() => canvas.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => canvas.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeLessThanOrEqual(1);
  await expect(fit).toBeInViewport();
  expect(requests).toBe(1);
});

test('small images can be enlarged and image failures disable zoom controls', async ({ page }) => {
  await page.goto(`/s/${svgShareId}#${shareSecret}`);
  await page.getByRole('button', { name: 'Zoom image in', exact: true }).click();
  await expect(page.getByLabel('Image zoom', { exact: true })).toHaveText('200%');
  await page.getByRole('button', { name: 'Zoom image out to fit', exact: true }).click();
  await expect(page.getByLabel('Image zoom', { exact: true })).toHaveText('100%');
  await page.route(`**/api/v1/public/shares/${svgShareId}/content`, (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: 'invalid image' }),
  );
  await page.reload();
  await expect(page.getByText('This image could not be loaded.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Actual size', exact: true })).toBeDisabled();
});
