import { spawn } from 'node:child_process';

const fixtureBytes = 64 * 1024 * 1024;
const rssLimitBytes = 32 * 1024 * 1024;

const childSource = `
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShelfApp } from './dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'shelf-memory-check-'));
const app = await createShelfApp({
  stagingRoot: root,
  multipartLimits: { fileSize: 128 * 1024 * 1024 },
  authenticator: {
    async authenticate() {
      return { installationId: 'memory', actorId: 'memory' };
    },
  },
  authorizer: { async authorize() {} },
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (address === null || typeof address === 'string') throw new Error('Missing TCP address.');

let baseline = 0;
let peak = 0;
let timer;
process.on('message', async (message) => {
  if (message?.type === 'begin') {
    baseline = process.memoryUsage().rss;
    peak = baseline;
    timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
  } else if (message?.type === 'end') {
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    process.send({ type: 'measurement', delta: peak - baseline });
  } else if (message?.type === 'stop') {
    clearInterval(timer);
    await app.close();
    await rm(root, { recursive: true, force: true });
    process.exit(0);
  }
});
process.send({ type: 'ready', port: address.port });
`;

const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
child.stderr.setEncoding('utf8');
let childError = '';
child.stderr.on('data', (chunk) => {
  childError += chunk;
});

function waitForMessage(type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`API child exited ${code}: ${childError}`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function multipartStream(byteCount) {
  const boundary = 'shelf-memory-boundary';
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="memory.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  let phase = 0;
  let remaining = byteCount;
  return {
    boundary,
    body: new ReadableStream({
      pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(prefix);
          return;
        }
        if (remaining > 0) {
          const size = Math.min(64 * 1024, remaining);
          controller.enqueue(new Uint8Array(size));
          remaining -= size;
          return;
        }
        if (phase === 1) {
          phase = 2;
          controller.enqueue(suffix);
          return;
        }
        controller.close();
      },
    }),
  };
}

async function upload(port, key) {
  const { boundary, body } = multipartStream(fixtureBytes);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/workspaces/memory/artifacts`, {
    method: 'POST',
    duplex: 'half',
    headers: {
      authorization: 'Bearer memory',
      'idempotency-key': key,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (response.status !== 201) {
    throw new Error(`Upload failed ${response.status}: ${await response.text()}`);
  }
  await response.arrayBuffer();
}

const ready = await waitForMessage('ready');
try {
  await upload(ready.port, 'warmup');
  const deltas = [];
  for (let run = 1; run <= 3; run += 1) {
    const measurement = waitForMessage('measurement');
    child.send({ type: 'begin' });
    await upload(ready.port, `measurement-${run}`);
    child.send({ type: 'end' });
    deltas.push((await measurement).delta);
  }

  const passed = deltas.every((delta) => delta < rssLimitBytes);
  process.stdout.write(
    `${JSON.stringify({
      fixtureMiB: fixtureBytes / 1024 / 1024,
      warmupMiB: fixtureBytes / 1024 / 1024,
      peakRssGrowthMiB: deltas.map((delta) => Number((delta / 1024 / 1024).toFixed(2))),
      limitMiB: rssLimitBytes / 1024 / 1024,
      passed,
    })}\n`,
  );
  if (!passed) process.exitCode = 1;
} finally {
  child.send({ type: 'stop' });
  await new Promise((resolve) => child.once('exit', resolve));
}
