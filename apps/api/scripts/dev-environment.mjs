#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const environmentPath = '.env.dev';
const contentRoot = './data/dev-content';

const environment = [
  'DATABASE_URL=postgresql:///shelf_dev',
  'SHELF_STORAGE_DRIVER=local',
  `SHELF_STORAGE_LOCAL_ROOT=${contentRoot}`,
  'SHELF_INSTALLATION_ID=installation-dev',
  'SHELF_AUTH_BASE_URL=http://127.0.0.1:3000',
  `SHELF_AUTH_SECRET=${randomBytes(32).toString('base64url')}`,
  'SHELF_HOST=127.0.0.1',
  'SHELF_PORT=3000',
  '',
].join('\n');

let status = 'created';
let activeContentRoot = contentRoot;
try {
  const handle = await open(environmentPath, 'wx', 0o600);
  try {
    await handle.writeFile(environment, 'utf8');
  } finally {
    await handle.close();
  }
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    status = 'exists';
    activeContentRoot = parseEnv(await readFile(environmentPath, 'utf8')).SHELF_STORAGE_LOCAL_ROOT;
  } else {
    throw error;
  }
}

if (activeContentRoot !== undefined) {
  await mkdir(activeContentRoot, { recursive: true, mode: 0o700 });
}
process.stdout.write(`${JSON.stringify({ status, path: environmentPath })}\n`);
