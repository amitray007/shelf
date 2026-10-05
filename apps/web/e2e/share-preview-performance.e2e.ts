import { deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { folderShareId, folderTreePage, markdownShareId, shareSecret } from './fixtures.js';

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

async function installLayoutShiftObserver(page: Page) {
  await page.addInitScript(() => {
    const entries: { readonly value: number }[] = [];
    Reflect.set(window, '__shelfLayoutShifts', entries);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            readonly hadRecentInput?: boolean;
            readonly value?: number;
          };
          if (!shift.hadRecentInput && shift.value !== undefined)
            entries.push({ value: shift.value });
        }
      }).observe({ buffered: true, type: 'layout-shift' });
    } catch {
      Reflect.set(window, '__shelfLayoutShifts', null);
    }
  });
}

async function resetLayoutShiftEntries(page: Page) {
  await page.evaluate(() => {
    const entries = Reflect.get(window, '__shelfLayoutShifts');
    if (Array.isArray(entries)) entries.length = 0;
  });
}

async function layoutShiftEntries(page: Page) {
  return page.evaluate(() => Reflect.get(window, '__shelfLayoutShifts')) as Promise<
    { readonly value: number }[] | null
  >;
}

async function openArtifactDetails(page: Page) {
  await page.getByRole('button', { name: 'Open artifact details', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Close artifact details', exact: true }),
  ).toBeVisible();
}

async function closeArtifactDetails(page: Page) {
  await page.getByRole('button', { name: 'Close artifact details', exact: true }).click();
}

test('a shared file opens before slow bytes and unrelated config finish', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The Layout Shift API is only asserted in Chromium.');
  await installLayoutShiftObserver(page);
  let releaseContent!: () => void;
  let releaseConfig!: () => void;
  const contentGate = new Promise<void>((resolve) => {
    releaseContent = resolve;
  });
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route('**/api/v1/public/config', async (route) => {
    await configGate;
    await route.continue();
  });
  await page.route(`**/api/v1/public/shares/${markdownShareId}/content`, async (route) => {
    await contentGate;
    await route.continue();
  });

  try {
    await page.goto(`/s/${markdownShareId}#${shareSecret}`);
    await expect(page.getByRole('button', { name: 'Open artifact details' })).toBeVisible();
    await expect(page.getByText('Opening artifact…')).toBeVisible();
    await resetLayoutShiftEntries(page);
    releaseContent();
    await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
      'One useful idea',
    );
    await expect(page.locator('.file-view-content')).toHaveCSS('animation-name', 'none');
    expect(await layoutShiftEntries(page)).toEqual([]);
  } finally {
    releaseContent();
    releaseConfig();
  }
});

test('the Markdown renderer keeps the loading indicator centered while its chunk loads', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/assets\/markdown-view-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/s/${markdownShareId}#${shareSecret}`);
    const document = page.getByRole('region', { name: 'Artifact document preview' });
    const loader = document.getByRole('status');
    await expect(loader).toBeVisible();
    const canvas = await document.boundingBox();
    const indicator = await loader.boundingBox();
    expect(canvas).not.toBeNull();
    expect(indicator).not.toBeNull();
    if (!canvas || !indicator) throw new Error('Loading geometry is missing');
    expect(
      Math.abs(indicator.y + indicator.height / 2 - (canvas.y + canvas.height / 2)),
    ).toBeLessThanOrEqual(1);
    release();
    await expect(page.getByRole('heading', { name: 'One useful idea', exact: true })).toBeVisible();
    expect(await document.boundingBox()).toEqual(canvas);
  } finally {
    release();
  }
});

test('the shared preview does not translate into place', async ({ page }) => {
  await page.goto(`/s/${markdownShareId}#${shareSecret}`);
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'One useful idea',
  );
  await expect(page.locator('.file-view-content')).toHaveCSS('animation-name', 'none');
});

test('the loading shell keeps the viewer canvas stable while the viewer UI chunk is delayed', async ({
  page,
}) => {
  let resolveRequests = 0;
  let configRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/public/shares/${markdownShareId}/resolve`)) {
      resolveRequests += 1;
    }
    if (request.url().endsWith('/api/v1/public/config')) configRequests += 1;
  });
  let releaseViewer!: () => void;
  const viewerGate = new Promise<void>((resolve) => {
    releaseViewer = resolve;
  });
  await page.route(/\/assets\/viewer-page-[^/]+\.js$/, async (route) => {
    await viewerGate;
    await route.continue();
  });
  const establishing = page.waitForRequest((request) =>
    request.url().includes(`/api/v1/public/shares/${markdownShareId}/sessions`),
  );
  const loadingContent = page.waitForRequest((request) =>
    request.url().includes(`/api/v1/public/shares/${markdownShareId}/content`),
  );

  try {
    await page.goto(`/s/${markdownShareId}#${shareSecret}`, { waitUntil: 'domcontentloaded' });
    const pendingCanvas = await page.locator('.viewer-pending').boundingBox();
    const launcher = await page
      .getByRole('button', { name: 'Open artifact details', exact: true })
      .boundingBox();
    expect(pendingCanvas).not.toBeNull();
    expect(launcher).not.toBeNull();
    expect(await page.locator('.rail, .viewer-toolbar').count()).toBe(0);
    if (pendingCanvas === null || launcher === null) throw new Error('Loading shell is missing');
    expect(pendingCanvas.x).toBe(0);
    expect(pendingCanvas.y).toBe(0);
    expect(pendingCanvas.height).toBe(page.viewportSize()?.height);
    expect(launcher.x + launcher.width).toBeLessThanOrEqual(pendingCanvas.width);
    expect(launcher.y + launcher.height).toBeLessThanOrEqual(pendingCanvas.height);
    expect(launcher.x).toBeGreaterThan(pendingCanvas.width / 2);
    expect(launcher.y).toBeGreaterThan(pendingCanvas.height / 2);
    await establishing;
    await loadingContent;
  } finally {
    releaseViewer();
  }
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toContainText(
    'One useful idea',
  );
  const contentCanvas = await page.locator('.viewer-main').boundingBox();
  expect(contentCanvas).not.toBeNull();
  if (contentCanvas === null) throw new Error('Viewer content is missing');
  expect(contentCanvas.x).toBe(0);
  expect(contentCanvas.y).toBe(0);
  expect(contentCanvas.width).toBe(page.viewportSize()?.width);
  expect(resolveRequests).toBe(0);
  expect(configRequests).toBe(0);
});

test('a shared folder opens before its first tree page finishes', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The Layout Shift API is only asserted in Chromium.');
  await installLayoutShiftObserver(page);
  let releaseTree!: () => void;
  const treeGate = new Promise<void>((resolve) => {
    releaseTree = resolve;
  });
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree`, async (route) => {
    await treeGate;
    await route.continue();
  });

  try {
    await page.goto(`/s/${folderShareId}#${shareSecret}`);
    await expect(page.getByRole('region', { name: 'Folder browser' })).toBeVisible();
    await expect(page.getByText('Opening artifact…').first()).toBeVisible();
    await expect(page.getByText('This folder is empty.')).toHaveCount(0);
    await resetLayoutShiftEntries(page);
    releaseTree();
    await expect(page.getByRole('region', { name: 'Artifact document preview' })).toBeVisible();
    await expect(page.locator('.file-view-content')).toHaveCSS('animation-name', 'none');
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(await layoutShiftEntries(page)).toEqual([]);
  } finally {
    releaseTree();
  }
});

test('a failed initial folder request exposes Retry without opening the sidebar', async ({
  page,
}) => {
  let fail = true;
  await page.route(`**/api/v1/public/shares/${folderShareId}/tree`, async (route) => {
    if (fail) {
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });
  await page.goto(`/s/${folderShareId}#${shareSecret}`);
  const listing = page.getByRole('region', { name: 'Folder files' });
  await expect(listing).toContainText('Some files could not be loaded.');
  fail = false;
  await listing.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('region', { name: 'Artifact document preview' })).toBeVisible();
});

async function selectImage(page: Page, name: string) {
  await expect(page.getByRole('region', { name: 'Folder browser' })).toBeVisible();
  await openArtifactDetails(page);
  const toggle = page.getByRole('button', { name: 'Open files sidebar', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await closeArtifactDetails(page);
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

test('folder images reuse bytes and fit the available viewport with details open or closed', async ({
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
    await expect(page.locator('.file-view-content')).toHaveCSS('animation-name', 'none');
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
      if (state === 0) await openArtifactDetails(page);
      else await closeArtifactDetails(page);
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
    await openArtifactDetails(page);
    const expand = page.getByRole('button', { name: 'Open files sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await closeArtifactDetails(page);
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
