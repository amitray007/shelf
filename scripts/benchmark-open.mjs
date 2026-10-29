#!/usr/bin/env node
/**
 * Real-stack artifact-open benchmark. Build first with pnpm build.
 * --smoke: 1 open/cell, no warmups. --iterations N: default 3, plus 1 warmup/cell.
 * Only DATABASE_URL is read from .env.dev; every other setting is isolated here.
 * WARNING: resets ONLY shelf_bench_open, on the configured PostgreSQL server.
 *
 * Timing uses browser epoch timestamps, never Node polling/locator durations.
 * A document-start probe checks content and visibility every 2 ms. Child frames
 * signal readiness to the parent; the parent also checks iframe visibility.
 * Navigation starts at performance.timeOrigin; SPA starts at the captured click.
 * Chromium clamps the 2 ms timer to ~4 ms after its initial ticks. Nominal
 * observation overhead stays below 5 ms; scheduler stalls can exceed that.
 * Final Playwright assertions independently verify the actual rendered content.
 * Cache: each owner open uses a new authenticated context primed once with that
 * artifact (including lazy assets), then a fresh page in that same HTTP cache.
 * First share opens use a new context. Return opens prime the full link once,
 * drain it, then open that same full link (including fragment) in a fresh page
 * in the same context, preserving stored sessions and HTTP cache. Every sample
 * has its own context; warmups never leak browser caches.
 * --scenarios a,b selects timed cells; --resilience-only skips timed cells;
 * --no-resilience skips faults. Default includes all six scenarios and faults.
 * --resilience-rounds N defaults to 3 (smoke: 1). Timed defaults reduce 7 measurements + 2 warmups
 * to 3 + 1 to keep the expanded default near nine minutes.
 * Faults run in batches of four fresh contexts for both access modes and all kinds:
 * resolution_503: first resolve or sessions API request gets retryable JSON 503;
 * content_reset: first content or tree API request aborts connectionreset;
 * renderer_503: first renderer iframe document gets 503 (HTML/folder only);
 * api_restart: every /api/ request aborts connectionrefused for 1500 ms from
 * navigation start, then passes through. Only resilience uses network routes.
 * Pass requires probe readiness AND independent content verification by 10 s,
 * with no reload or user action. Recovery uses browser epoch time to readiness.
 * A fault must actually fire to pass. Fail counts include non-injected cases.
 * Fault errors never enter timed errors/all_rendered. Rate is passed/total.
 * Missing subset aggregates are null; open_ms_geomean always requires the
 * original 16 cells, share_open_ms_geomean all 16 share cells.
 * Runtime reduction: four concurrent fault cases bound deadlines to 70 seconds
 * per round (28 cases, including 4 renderer cases), plus setup/draining.
 * Fault concurrency can affect recovery timing; timed cells remain serial.
 * Requests count /api/ requests from start through observed readiness, all frames;
 * reported count is the median across measured opens, excluding setup/priming.
 * Cells run serially, round-robin, with equal state for warmups and measurements.
 * Owner HTML verifies a known string in the source view, not /preview/:id.
 * Owner folder verifies the entry tree plus app.js source (the lexicographically
 * first fixture file, selected by default). No file selection is injected.
 * The owner folder sidebar starts collapsed. The probe activates its existing
 * toolbar button once as part of the timed open, then requires its app.js entry
 * and selected source to be visible. This reveal is included in the cell time.
 * Shares verify heading text in the cross-origin renderer iframe; folder also
 * verifies its script ran. Source probing traverses Pierre's open shadow root.
 * Origins: API/web 127.0.0.1:3200; renderer localhost:3201. Renderer APP_ORIGIN
 * names the embedding application (127.0.0.1), not the renderer itself.
 * CDP applies the profile to both page and out-of-process iframe targets.
 * Fixtures and the stack use HTTP loopback only. HTTPS subresources (such as
 * optional external avatars) are blocked by CDP, which preserves the HTTP cache.
 * Priming/list navigations wait for commit plus verified content, not window.load.
 * Run on an idle host: scheduler and memory pressure are included, not normalized.
 * After recording/verification, every page drains to network idle before context
 * teardown. This is outside the measured window and avoids aborting local streams.
 * No product mocks, source edits, or dev servers are used.
 * --storage r2 runs the API on the real R2 driver. It reads BENCH_R2_ACCOUNT_ID,
 * BENCH_R2_BUCKET, BENCH_R2_ACCESS_KEY_ID, and BENCH_R2_SECRET_ACCESS_KEY, and
 * passes NODE_EXTRA_CA_CERTS through, so a host can point the R2 hostname at an
 * S3-compatible emulator behind a latency proxy. Each run uses a fresh prefix.
 * Downloads: after timed cells, Node fetches 1 MiB and 8 MiB share files over
 * loopback (no CDP profile) for both access types. Each cell takes one warmup,
 * then `iterations` timed full-body reads; time is request start to last byte.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const NETWORK = Object.freeze({
  offline: false,
  latency: 40,
  downloadThroughput: 50_000_000 / 8,
  uploadThroughput: 20_000_000 / 8,
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:3200';
const RENDERER = 'http://localhost:3201';
const ORIGINAL_SCENARIOS = [
  'owner_navigate',
  'owner_click',
  'share_protected_first',
  'share_public_first',
];
const SCENARIOS = [...ORIGINAL_SCENARIOS, 'share_protected_return', 'share_public_return'];
const KINDS = ['markdown', 'html', 'image', 'folder'];
const webRequire = createRequire(join(ROOT, 'apps/web/package.json'));
const apiRequire = createRequire(join(ROOT, 'apps/api/package.json'));
const { chromium, expect } = webRequire('@playwright/test');
const { Client } = apiRequire('pg');
const children = new Set();
const pageRequests = new WeakMap();
let browser;
let temporary;
let cleaning;
let databaseLock;
let instrumentationFailure;
const servers = new Set();
function log(message) {
  process.stderr.write(
    `${String(message).replace(/(https?:\/\/[^\s#]+)#[^\s'"]+/gu, '$1#[REDACTED]')}\n`,
  );
}
async function cleanup() {
  cleaning ??= (async () => {
    await browser?.close().catch(() => {});
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((done) => {
            if (child.exitCode !== null || child.signalCode !== null) return done();
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
            }, 2000);
            child.once('exit', () => {
              clearTimeout(timer);
              done();
            });
          }),
      ),
    );
    await databaseLock?.end().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(code));
  });
}
function childProcess(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}
async function command(script, args, env) {
  const child = childProcess(script, args, env);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code) =>
      code === 0
        ? done()
        : fail(
            new Error(
              `Command ${script} ${args[0]} failed (${code}): ${stderr.replaceAll(env.SHELF_TOKEN ?? '\0', '[REDACTED]')}`,
            ),
          ),
    );
  });
  return JSON.parse(stdout);
}
async function server(script, env) {
  const child = childProcess(script, [], env);
  servers.add(child);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${script} startup timeout`)), 20000);
    child.once('error', fail);
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`${script} exited ${code}`));
    });
    child.stderr.on('data', (chunk) => log(String(chunk).trim()));
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('"started"')) {
        clearTimeout(timer);
        done();
      }
    });
  });
}
async function portFree(port) {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', () =>
      fail(new Error(`Port ${port} is occupied; refusing to reuse or kill it`)),
    );
    server.listen(port, '127.0.0.1', done);
  });
  await new Promise((done) => server.close(done));
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
// Serialized into every browser document, including renderer frames.
function installProbe({ kind, owner }) {
  const headings = {
    markdown: 'Shelf benchmark markdown ready',
    html: 'Shelf benchmark HTML ready',
    folder: 'Shelf benchmark folder ready',
  };
  const visible = (el) => {
    if (!el?.getClientRects().length) return false;
    const box = el.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.top < innerHeight &&
      box.right > 0 &&
      box.left < innerWidth &&
      el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
    );
  };
  let frameReady = false;
  let folderSidebarOpened = false;
  window.addEventListener('message', (event) => {
    if (event.data !== 'shelf-bench-content-ready') return;
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.contentWindow === event.source) frameReady = true;
    }
  });
  window.__bench = { start: performance.timeOrigin, end: null };
  document.addEventListener(
    'click',
    (event) => {
      if (event.target.closest('a[data-benchmark-target]')) {
        window.__bench = { start: performance.timeOrigin + performance.now(), end: null };
      }
    },
    true,
  );
  const timer = setInterval(() => {
    let ready;
    if (owner && (kind === 'html' || kind === 'folder')) {
      if (kind === 'folder' && !folderSidebarOpened) {
        const toggle = document.querySelector(
          'button[aria-controls="managed-folder-sidebar-content"][aria-expanded="false"]',
        );
        if (toggle && visible(toggle)) {
          folderSidebarOpened = true;
          toggle.click();
        }
      }
      const marker = kind === 'html' ? headings.html : 'Folder script ready';
      const sourceVisible = [...document.querySelectorAll('diffs-container')].some((host) =>
        [...(host.shadowRoot?.querySelectorAll('[data-line]') ?? [])].some(
          (line) => line.textContent.includes(marker) && visible(line),
        ),
      );
      const tree = document.querySelector('[aria-label="Folder contents"]');
      const treeReady = [...(tree?.shadowRoot?.querySelectorAll('[role="treeitem"]') ?? [])].some(
        (item) => item.getAttribute('data-item-path') === 'app.js' && visible(item),
      );
      ready = sourceVisible && (kind !== 'folder' || treeReady);
    } else if (kind === 'image') {
      ready = [...document.querySelectorAll('.image-preview img')].some(
        (img) => img.complete && img.naturalWidth > 0 && visible(img),
      );
    } else if (kind === 'html' || kind === 'folder') {
      if (window === window.top) {
        ready = frameReady && [...document.querySelectorAll('iframe')].some(visible);
      } else
        ready = [...document.querySelectorAll('h1')].some(
          (el) => el.textContent === headings[kind] && visible(el),
        );
    } else
      ready = [...document.querySelectorAll('h1')].some(
        (el) => el.textContent === headings[kind] && visible(el),
      );
    if (!ready) return;
    if (window !== window.top) {
      window.parent.postMessage('shelf-bench-content-ready', '*');
      clearInterval(timer);
    } else if (window.__bench.end === null)
      window.__bench.end = performance.timeOrigin + performance.now();
  }, 2);
}
async function verify(page, kind, owner) {
  if (owner && ['html', 'folder'].includes(kind)) {
    const marker = kind === 'html' ? 'Shelf benchmark HTML ready' : 'Folder script ready';
    await expect(
      page.locator('diffs-container [data-line]').filter({ hasText: marker }).first(),
    ).toBeVisible();
    if (kind === 'folder') {
      await expect(
        page
          .locator('[aria-label="Folder contents"]')
          .getByRole('treeitem', { name: 'app.js', exact: true }),
      ).toBeVisible();
    }
    return;
  }
  if (kind === 'image') {
    const img = page.locator('.image-preview img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  } else {
    const text = `Shelf benchmark ${kind === 'html' ? 'HTML' : kind} ready`;
    const scope = ['html', 'folder'].includes(kind) ? page.frameLocator('iframe') : page;
    await expect(scope.getByRole('heading', { name: text, exact: true })).toBeVisible();
    if (kind === 'folder') await expect(scope.getByText('Folder script ready')).toBeVisible();
  }
}
async function throttledPage(context) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const requests = new Map();
  pageRequests.set(page, requests);
  const recordRequest = (event) => {
    if (new URL(event.request.url).pathname.startsWith('/api/')) {
      requests.set(`${event.requestId}:${event.wallTime}`, event.wallTime * 1000);
    }
  };
  cdp.on('Network.requestWillBeSent', recordRequest);
  // Sandboxed cross-origin previews become OOPIF targets. Pause each new target
  // before its scripts run, set the same network profile, then resume it. The
  // initial navigation request belongs to the parent target before that swap.
  let nextId = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const response = JSON.parse(message);
    if (response.method === 'Network.requestWillBeSent') recordRequest(response.params);
    if (!response.id) return;
    const key = `${sessionId}:${response.id}`;
    const callback = pending.get(key);
    if (!callback) return;
    pending.delete(key);
    if (response.error) callback.reject(new Error(response.error.message));
    else callback.resolve(response.result);
  });
  function sendChild(sessionId, method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(`${sessionId}:${id}`, { resolve, reject });
      cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
    });
  }
  cdp.on('Target.attachedToTarget', ({ sessionId }) => {
    void (async () => {
      try {
        await sendChild(sessionId, 'Network.enable');
        await sendChild(sessionId, 'Network.emulateNetworkConditions', NETWORK);
      } catch (error) {
        instrumentationFailure = error;
      } finally {
        await sendChild(sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => {});
      }
    })();
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: false,
    filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
  });
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await cdp.send('Network.emulateNetworkConditions', NETWORK);
  return page;
}
async function openCell(fixture, scenario, storageState) {
  const owner = scenario.startsWith('owner');
  const context = await browser.newContext({
    ...(owner ? { storageState } : {}),
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  try {
    await context.addInitScript(installProbe, { kind: fixture.kind, owner });
    const detail = `${ORIGIN}/app/w/bench/artifacts/${fixture.id}`;
    const shareUrl = fixture[scenario.startsWith('share_public') ? 'public' : 'protected'];
    if (owner || scenario.endsWith('_return')) {
      const prime = await throttledPage(context);
      await prime.goto(owner ? detail : shareUrl, { waitUntil: 'commit' });
      await verify(prime, fixture.kind, owner);
      await prime.waitForLoadState('networkidle');
      await prime.close();
    }
    const page = await throttledPage(context);
    if (scenario === 'owner_click') {
      await page.goto(`${ORIGIN}/app/w/bench/artifacts`, { waitUntil: 'commit' });
      await expect(page.getByRole('link', { name: fixture.title, exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page
        .getByRole('link', { name: fixture.title, exact: true })
        .evaluate((el) => el.setAttribute('data-benchmark-target', ''));
    }
    const requests = pageRequests.get(page);
    if (scenario === 'owner_click')
      await page.getByRole('link', { name: fixture.title, exact: true }).click();
    else await page.goto(owner ? detail : shareUrl, { waitUntil: 'commit' });
    await page.waitForFunction(
      () => window.__bench?.end !== null && window.__bench?.end !== undefined,
      {},
      { timeout: 15000, polling: 5 },
    );
    const timing = await page.evaluate(() => window.__bench);
    await verify(page, fixture.kind, owner);
    return {
      ms: timing.end - timing.start,
      requests: [...requests.values()].filter((time) => time >= timing.start && time <= timing.end)
        .length,
    };
  } finally {
    // Content can become visible before ancillary image/content streams finish.
    // Drain outside the timed window so teardown does not abort those streams.
    await Promise.all(
      context
        .pages()
        .map((page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})),
    );
    await context.close();
  }
}
async function resilienceCase(fixture, access, fault) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });
  let injected = false;
  let started = 0;
  try {
    await context.addInitScript(installProbe, { kind: fixture.kind, owner: false });
    const page = await throttledPage(context);
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const api = url.pathname.startsWith('/api/');
      if (fault === 'api_restart' && api && Date.now() - started < 1500) {
        injected = true;
        return route.abort('connectionrefused');
      }
      if (!injected) {
        if (fault === 'resolution_503' && api && /\/(resolve|sessions)$/.test(url.pathname)) {
          injected = true;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: 'Service unavailable.',
                retryable: true,
                requestId: 'bench',
              },
            }),
          });
        }
        if (fault === 'content_reset' && api && /\/(content|tree)(\/|$)/.test(url.pathname)) {
          injected = true;
          return route.abort('connectionreset');
        }
        if (
          fault === 'renderer_503' &&
          url.origin === RENDERER &&
          request.isNavigationRequest() &&
          request.frame() !== page.mainFrame()
        ) {
          injected = true;
          return route.fulfill({
            status: 503,
            contentType: 'text/plain',
            body: 'Service unavailable.',
          });
        }
      }
      return route.continue();
    });
    started = Date.now();
    const deadline = started + 10000;
    await page.goto(fixture[access], { waitUntil: 'commit', timeout: 10000 });
    await page.waitForFunction(
      () => window.__bench?.end != null,
      {},
      { timeout: Math.max(1, deadline - Date.now()), polling: 5 },
    );
    await Promise.race([
      verify(page, fixture.kind, false),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Verification deadline')),
          Math.max(1, deadline - Date.now()),
        );
        timer.unref();
      }),
    ]);
    const timing = await page.evaluate(() => window.__bench);
    return injected && Date.now() <= deadline && timing.end - timing.start <= 10000
      ? timing.end - timing.start
      : null;
  } catch {
    return null;
  } finally {
    await Promise.all(
      context
        .pages()
        .map((page) => page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})),
    );
    await context.close();
  }
}
function storageEnvironment(storage) {
  if (storage === 'local')
    return { SHELF_STORAGE_DRIVER: 'local', SHELF_STORAGE_LOCAL_ROOT: join(temporary, 'storage') };
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`--storage r2 requires ${name}`);
    return value;
  };
  return {
    SHELF_STORAGE_DRIVER: 'r2',
    SHELF_R2_ACCOUNT_ID: required('BENCH_R2_ACCOUNT_ID'),
    SHELF_R2_BUCKET: required('BENCH_R2_BUCKET'),
    SHELF_R2_ACCESS_KEY_ID: required('BENCH_R2_ACCESS_KEY_ID'),
    SHELF_R2_SECRET_ACCESS_KEY: required('BENCH_R2_SECRET_ACCESS_KEY'),
    SHELF_STORAGE_PREFIX: `bench-${randomUUID()}`,
    ...(process.env.NODE_EXTRA_CA_CERTS === undefined
      ? {}
      : { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }),
  };
}
// Deterministic bytes, so every run and candidate downloads identical files.
function downloadBytes(size) {
  const blocks = [];
  for (let i = 0; blocks.length * 32 < size; i++)
    blocks.push(createHash('sha256').update(`shelf-download-${i}`).digest());
  return Buffer.concat(blocks).subarray(0, size);
}
async function publishDownloads(cli) {
  const cells = [];
  for (const [label, size] of [
    ['1mib', 1024 * 1024],
    ['8mib', 8 * 1024 * 1024],
  ]) {
    const file = join(temporary, `download-${label}.bin`);
    await writeFile(file, downloadBytes(size));
    const published = await cli(
      'publish',
      file,
      '--title',
      `Benchmark download ${label}`,
      '--description',
      'Deterministic download benchmark fixture',
    );
    const id = published.publish.artifactId;
    for (const access of ['protected', 'public']) {
      const shared = await cli(
        'shares',
        'create',
        '--artifact',
        id,
        '--access',
        access,
        '--idempotency-key',
        `download-${label}-${access}`,
      );
      const url = new URL(shared.url, ORIGIN);
      const cell = { access, label, size, samples: [] };
      if (access === 'public') {
        const code = url.pathname.split('/').at(-1);
        cell.request = () => fetch(`${ORIGIN}/api/v1/public/links/${code}/content`);
      } else {
        const shareId = url.pathname.split('/').at(-1);
        const session = await fetch(`${ORIGIN}/api/v1/public/shares/${shareId}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: randomUUID(), secret: url.hash.slice(1) }),
        });
        if (!session.ok) throw new Error(`Download session failed: ${session.status}`);
        const established = await session.json();
        const body = JSON.stringify({
          token: established.token,
          revisionId: established.resolution.revision.revisionId,
        });
        cell.request = () =>
          fetch(`${ORIGIN}/api/v1/public/shares/${shareId}/content`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
      }
      cells.push(cell);
    }
  }
  return cells;
}
async function downloadOnce(cell) {
  const started = performance.now();
  const response = await cell.request();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ms = performance.now() - started;
  if (!bytes.equals(downloadBytes(cell.size))) throw new Error('Downloaded bytes differ');
  return ms;
}
async function main() {
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--smoke', '--resilience-only', '--no-resilience'].includes(flag)) options.set(flag, true);
    else if (['--iterations', '--resilience-rounds', '--scenarios', '--storage'].includes(flag))
      options.set(flag, args[++i]);
    else throw new Error(`Unknown flag: ${flag}`);
  }
  const iterations = smoke ? 1 : Number(options.get('--iterations') ?? 3);
  const resilienceRounds = Number(options.get('--resilience-rounds') ?? (smoke ? 1 : 3));
  const scenarios = options.has('--resilience-only')
    ? []
    : String(options.get('--scenarios') ?? SCENARIOS.join(',')).split(',');
  if (
    ![iterations, resilienceRounds].every((n) => Number.isInteger(n) && n > 0) ||
    scenarios.some((scenario) => !SCENARIOS.includes(scenario)) ||
    new Set(scenarios).size !== scenarios.length ||
    (options.has('--resilience-only') && options.has('--no-resilience')) ||
    !['local', 'r2'].includes(String(options.get('--storage') ?? 'local'))
  )
    throw new Error('Invalid benchmark options');
  await portFree(3200);
  await portFree(3201);
  temporary = await mkdtemp(join(tmpdir(), 'shelf-bench-open-'));
  const dev = parseEnv(await readFile(join(ROOT, '.env.dev'), 'utf8'));
  const database = new URL(dev.DATABASE_URL);
  if (database.pathname === '/shelf_bench_open')
    throw new Error('.env.dev must identify the dev database, not the benchmark database');
  database.pathname = '/postgres';
  databaseLock = new Client({ connectionString: database.href });
  await databaseLock.connect();
  const lock = await databaseLock.query('SELECT pg_try_advisory_lock(72319841) AS locked');
  if (!lock.rows[0].locked) throw new Error('Another benchmark is running');
  await databaseLock.query('DROP DATABASE IF EXISTS shelf_bench_open WITH (FORCE)');
  await databaseLock.query('CREATE DATABASE shelf_bench_open');
  database.pathname = '/shelf_bench_open';
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    DATABASE_URL: database.href,
    SHELF_INSTALLATION_ID: 'bench-open',
    SHELF_HOST: '127.0.0.1',
    SHELF_PORT: '3200',
    SHELF_AUTH_BASE_URL: ORIGIN,
    SHELF_RENDERER_HOST: '127.0.0.1',
    SHELF_RENDERER_PORT: '3201',
    SHELF_RENDERER_PUBLIC_ORIGIN: RENDERER,
    SHELF_RENDERER_APP_ORIGIN: ORIGIN,
    SHELF_WEB_ROOT: join(ROOT, 'apps/web/dist'),
    ...storageEnvironment(String(options.get('--storage') ?? 'local')),
    SHELF_AUTH_SECRET: 'benchmark-auth-secret-0000000000000000',
    SHELF_SHARE_SIGNING_KEY: 'benchmark-share-key-00000000000000000',
    SHELF_PRIVACY_KEY: 'benchmark-privacy-key-0000000000000000',
    SHELF_CONFIG_DIR: join(temporary, 'config'),
    SHELF_DATA_DIR: join(temporary, 'data'),
  };
  const admin = (...args) => command('apps/api/dist/operator/cli.js', args, env);
  const cli = (...args) => command('apps/cli/dist/index.js', args, env);
  await admin('migrate');
  const password = 'Benchmark-local-only-142!';
  const passwordFile = join(temporary, 'password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  const grants = ['--grant', 'bench:file.publish', '--grant', 'bench:revision.read'];
  await admin(
    'owner',
    'bootstrap',
    '--email',
    'bench@example.test',
    '--name',
    'Benchmark',
    '--password-file',
    passwordFile,
    '--grant',
    'bootstrap:file.publish',
    '--grant',
    'bootstrap:revision.read',
  );
  await admin('workspace', 'create', '--id', 'bench');
  const credential = await admin('credential', 'issue', '--name', 'Benchmark publisher', ...grants);
  env.SHELF_TOKEN = credential.token;
  if (!env.SHELF_TOKEN) throw new Error('Operator returned no credential');
  await server('apps/api/dist/server-cli.js', env);
  await server('apps/api/dist/renderer-cli.js', env);
  await cli(
    'profiles',
    'set',
    'default',
    '--url',
    ORIGIN,
    '--workspace',
    'bench',
    '--credential-env',
    'SHELF_TOKEN',
    '--allow-insecure-loopback',
  );
  const fixtures = [];
  const paths = ['document.md', 'page.html', 'image.png', 'site'];
  for (const [i, kind] of KINDS.entries()) {
    const title = `Benchmark ${kind}`;
    const published = await cli(
      'publish',
      join(ROOT, 'scripts/benchmark-open/fixtures', paths[i]),
      '--title',
      title,
      '--description',
      'Deterministic open benchmark fixture',
    );
    const id = published.publish.artifactId;
    if (!id) throw new Error('Publish returned no artifact ID');
    const fixture = { kind, title, id };
    for (const access of ['protected', 'public']) {
      const shared = await cli(
        'shares',
        'create',
        '--artifact',
        id,
        '--access',
        access,
        '--idempotency-key',
        `${kind}-${access}`,
      );
      fixture[access] = new URL(shared.url, ORIGIN).href;
    }
    fixtures.push(fixture);
  }
  const downloads = options.has('--resilience-only') ? [] : await publishDownloads(cli);
  browser = await chromium.launch();
  const login = await browser.newContext();
  const response = await login.request.post(`${ORIGIN}/api/auth/sign-in/email`, {
    headers: { Origin: ORIGIN },
    data: { email: 'bench@example.test', password },
  });
  if (!response.ok()) throw new Error(`Owner login failed: ${response.status()}`);
  const storageState = await login.storageState();
  if (!storageState.cookies.length) throw new Error('Owner login returned no session cookie');
  await login.close();
  const cells = fixtures.flatMap((fixture) =>
    scenarios.map((scenario) => ({ fixture, scenario, samples: [], counts: [] })),
  );
  let errors = 0;
  const warmups = smoke ? 0 : 1;
  for (let iteration = -warmups; iteration < iterations; iteration++) {
    log(`Round ${iteration < 0 ? `warmup ${iteration + warmups + 1}` : iteration + 1}`);
    for (const cell of cells) {
      if (instrumentationFailure) throw instrumentationFailure;
      if (
        !browser.isConnected() ||
        [...servers].some((child) => child.exitCode !== null || child.signalCode !== null)
      ) {
        throw new Error('Benchmark browser or stack exited unexpectedly');
      }
      try {
        const sample = await openCell(cell.fixture, cell.scenario, storageState);
        if (iteration >= 0) {
          cell.samples.push(sample.ms);
          cell.counts.push(sample.requests);
        }
      } catch (error) {
        errors++;
        log(`${cell.scenario}/${cell.fixture.kind}: ${error.message}`);
      }
    }
  }
  if (instrumentationFailure) throw instrumentationFailure;
  const output = { open_ms_geomean: null };
  for (const scenario of SCENARIOS) {
    const medians = cells
      .filter((cell) => cell.scenario === scenario)
      .map((cell) => (cell.samples.length ? median(cell.samples) : null));
    output[`${scenario}_ms_p50`] = medians.includes(null) ? null : median(medians);
  }
  for (const cell of cells) {
    const name = `${cell.scenario}_${cell.fixture.kind}`;
    output[`cell_${name}_ms_p50`] = cell.samples.length ? median(cell.samples) : null;
    output[`request_count_${name}`] = cell.counts.length ? median(cell.counts) : null;
  }
  output.all_rendered =
    errors === 0 && cells.every((cell) => cell.samples.length === iterations) ? 1 : 0;
  output.errors = errors;
  const aggregate = (selected, geometric = false) => {
    const selectedCells = cells.filter((cell) => selected.includes(cell.scenario));
    if (
      selectedCells.length !== selected.length * KINDS.length ||
      selectedCells.some((cell) => cell.samples.length !== iterations)
    )
      return null;
    const values = selectedCells.map((cell) => median(cell.samples));
    return geometric
      ? Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
      : median(values);
  };
  if (output.all_rendered) output.open_ms_geomean = aggregate(ORIGINAL_SCENARIOS, true);
  output.share_open_ms_geomean = aggregate(
    SCENARIOS.filter((scenario) => scenario.startsWith('share_')),
    true,
  );
  output.share_return_ms_p50 = aggregate(['share_protected_return', 'share_public_return']);
  for (const cell of downloads) {
    for (let iteration = -1; iteration < iterations; iteration++) {
      try {
        const ms = await downloadOnce(cell);
        if (iteration >= 0) cell.samples.push(ms);
      } catch (error) {
        errors++;
        output.errors = errors;
        output.all_rendered = 0;
        log(`download ${cell.access}/${cell.size}: ${error.message}`);
      }
    }
    output[`download_${cell.access}_${cell.label}_ms_p50`] =
      cell.samples.length === iterations ? median(cell.samples) : null;
  }
  output.download_ms_geomean =
    downloads.length && downloads.every((cell) => cell.samples.length === iterations)
      ? Math.exp(
          downloads.reduce((sum, cell) => sum + Math.log(median(cell.samples)), 0) /
            downloads.length,
        )
      : null;
  output.resilience_cases = 0;
  output.resilience_pass_rate = null;
  output.resilience_recover_ms_p50 = null;
  const recovered = [];
  if (!options.has('--no-resilience')) {
    for (let round = 0; round < resilienceRounds; round++) {
      log(`Resilience round ${round + 1}`);
      const cases = fixtures.flatMap((fixture) =>
        ['protected', 'public'].flatMap((access) =>
          [
            'resolution_503',
            'content_reset',
            'api_restart',
            ...(['html', 'folder'].includes(fixture.kind) ? ['renderer_503'] : []),
          ].map((fault) => ({ fixture, access, fault })),
        ),
      );
      for (let offset = 0; offset < cases.length; offset += 4) {
        const batch = cases.slice(offset, offset + 4);
        const results = await Promise.all(
          batch.map(({ fixture, access, fault }) => resilienceCase(fixture, access, fault)),
        );
        for (const [index, result] of results.entries()) {
          const { fixture, access, fault } = batch[index];
          output.resilience_cases++;
          if (result !== null) recovered.push(result);
          else {
            const key = `resilience_fail_${fault}_${access}_${fixture.kind}`;
            output[key] = (output[key] ?? 0) + 1;
            log(`Resilience failed: ${fault}/${access}/${fixture.kind}`);
          }
        }
      }
    }
    output.resilience_pass_rate = recovered.length / output.resilience_cases;
    output.resilience_recover_ms_p50 = recovered.length ? median(recovered) : null;
  }
  return output;
}
try {
  const output = await main();
  await cleanup();
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  log(`Harness failure: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
