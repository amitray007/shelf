#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const environmentPath = '.env.dev';
const contentRoot = './data/dev-content';
const shareSigningKey = randomBytes(32).toString('base64url');

const environment = [
  'DATABASE_URL=postgresql:///shelf_dev',
  'SHELF_STORAGE_DRIVER=local',
  `SHELF_STORAGE_LOCAL_ROOT=${contentRoot}`,
  'SHELF_INSTALLATION_ID=installation-dev',
  'SHELF_AUTH_BASE_URL=http://127.0.0.1:3000',
  `SHELF_AUTH_SECRET=${randomBytes(32).toString('base64url')}`,
  `SHELF_SHARE_SIGNING_KEY=${shareSigningKey}`,
  'SHELF_HOST=127.0.0.1',
  'SHELF_PORT=3000',
  'SHELF_RENDERER_APP_ORIGIN=http://127.0.0.1:5173',
  'SHELF_RENDERER_HOST=127.0.0.1',
  'SHELF_RENDERER_PORT=3001',
  'SHELF_RENDERER_PUBLIC_ORIGIN=http://127.0.0.1:3001',
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
    const file = await lstat(environmentPath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error('.env.dev must be a regular file.');
    }
    const existing = await readFile(environmentPath, 'utf8');
    const parsed = parseEnv(existing);
    activeContentRoot = parsed.SHELF_STORAGE_LOCAL_ROOT;
    const additions = [];
    if (
      parsed.SHELF_SHARE_SIGNING_KEY === undefined &&
      parsed.SHELF_SHARE_SIGNING_KEY_FILE === undefined
    )
      additions.push(`SHELF_SHARE_SIGNING_KEY=${shareSigningKey}`);
    for (const [name, value] of [
      ['SHELF_RENDERER_APP_ORIGIN', 'http://127.0.0.1:5173'],
      ['SHELF_RENDERER_HOST', '127.0.0.1'],
      ['SHELF_RENDERER_PORT', '3001'],
      ['SHELF_RENDERER_PUBLIC_ORIGIN', 'http://127.0.0.1:3001'],
    ]) {
      if (parsed[name] === undefined) additions.push(`${name}=${value}`);
    }
    if (additions.length > 0) {
      const handle = await open(environmentPath, 'a', 0o600);
      try {
        const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        await handle.writeFile(`${separator}${additions.join('\n')}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      status = 'updated';
    } else {
      status = 'exists';
    }
    await chmod(environmentPath, 0o600);
  } else {
    throw error;
  }
}

if (activeContentRoot !== undefined) {
  await mkdir(activeContentRoot, { recursive: true, mode: 0o700 });
}
process.stdout.write(`${JSON.stringify({ status, path: environmentPath })}\n`);
