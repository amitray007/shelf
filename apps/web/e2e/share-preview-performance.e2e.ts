import { deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { folderShareId, folderTreePage, shareSecret } from './fixtures.js';

// Small compressed fixtures with large intrinsic dimensions expose image layout overflow.
function png(width: number, height: number): Buffer {
  const chunk = (kind: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(kind), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const offset = row * (width * 3 + 1) + 1 + col * 3;
      pixels[offset] = 50 + Math.round((row / height) * 160);
      pixels[offset + 1] = 60;
      pixels[offset + 2] = 180;
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const images = { 'portrait.png': png(1600, 2400), 'landscape.png': png(3200, 1000) };
const entries = Object.entries(images).map(([path, bytes]) => ({
  path,
  kind: 'file' as const,
  mediaType: 'image/png',
  byteCount: bytes.length,
  contentHash: `sha256:${'a'.repeat(64)}`,
}));

async function selectImage(page: Page, name: string) {
  await page.getByRole('button', { name: /^(Show|Hide) controls$/ }).waitFor();
  const show = page.getByRole('button', { name: 'Show controls', exact: true });
  if (await show.isVisible()) await show.click();
  const toggle = page.getByRole('button', { name: /^(Open|Expand) folder files sidebar$/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('treeitem', { name, exact: true }).click();
  if ((page.viewportSize()?.width ?? 1440) <= 640) {
    const collapse = page.getByRole('button', {
      name: 'Close files sidebar',
      exact: true,
    });
    if (await collapse.isVisible()) await collapse.click();
  }
  const image = page.getByRole('img', { name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  return image;
}

test('folder images reuse bytes and fit the available viewport with controls open or closed', async ({
  page,
}) => {
  const requests = new Map<string, number>();
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/tree')) {
      await route.fulfill({ json: { ...folderTreePage, items: entries, nextCursor: null } });
    } else {
      const path = url.searchParams.get('path') as keyof typeof images;
      requests.set(path, (requests.get(path) ?? 0) + 1);
      await route.fulfill({ contentType: 'image/png', body: images[path] });
    }
  });
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  for (const name of ['portrait.png', 'landscape.png', 'portrait.png']) {
    const image = await selectImage(page, name);
    const fit = async () =>
      image.evaluate((element) => {
        const image = element as HTMLImageElement;
        const surface = image.parentElement;
        if (surface === null) throw new Error('Missing image surface');
        const bounds = image.getBoundingClientRect();
        const area = surface.getBoundingClientRect();
        return {
          horizontalOverflow: surface.scrollWidth - surface.clientWidth,
          verticalOverflow: surface.scrollHeight - surface.clientHeight,
          inside:
            bounds.top >= area.top &&
            bounds.bottom <= area.bottom + 1 &&
            bounds.left >= area.left &&
            bounds.right <= area.right + 1,
          centeredX: Math.abs(bounds.left + bounds.width / 2 - area.left - area.width / 2),
          centeredY: Math.abs(bounds.top + bounds.height / 2 - area.top - area.height / 2),
          ratio: bounds.width / bounds.height,
          originalRatio: image.naturalWidth / image.naturalHeight,
        };
      });
    for (let state = 0; state < 2; state += 1) {
      const metrics = await fit();
      expect(metrics.horizontalOverflow).toBeLessThanOrEqual(1);
      expect(metrics.verticalOverflow).toBeLessThanOrEqual(1);
      expect(metrics.inside).toBe(true);
      expect(metrics.centeredX).toBeLessThanOrEqual(1);
      expect(metrics.centeredY).toBeLessThanOrEqual(1);
      expect(metrics.ratio).toBeCloseTo(metrics.originalRatio, 2);
      await page
        .getByRole('button', { name: state === 0 ? 'Hide controls' : 'Show controls', exact: true })
        .click();
    }
  }
  expect(requests.get('portrait.png')).toBe(1);
  expect(requests.get('landscape.png')).toBe(1);
});

test('a slow folder page does not block opening or selecting the first files', async ({ page }) => {
  let release!: () => void;
  let delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/tree')) {
      if (url.searchParams.has('cursor')) {
        await delayed;
        await route.fulfill({ json: { ...folderTreePage, items: [entries[1]], nextCursor: null } });
      } else
        await route.fulfill({
          json: { ...folderTreePage, items: [entries[0]], nextCursor: 'second' },
        });
    } else await route.fulfill({ contentType: 'image/png', body: images['portrait.png'] });
  });
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  try {
    await selectImage(page, 'portrait.png');
    release();
    const expand = page.getByRole('button', { name: /^(Open|Expand) folder files sidebar$/ });
    if (await expand.isVisible()) await expand.click();
    await expect(page.getByRole('treeitem', { name: 'landscape.png', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'portrait.png', exact: true })).toHaveAttribute(
      'src',
      /^blob:/,
    );
    await selectImage(page, 'landscape.png');
    delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.reload();
    await expect(page.getByRole('region', { name: 'Folder browser' })).toBeVisible();
    release();
    await expect(page.getByRole('img', { name: 'landscape.png', exact: true })).toHaveAttribute(
      'src',
      /^blob:/,
    );
  } finally {
    release();
  }
});
