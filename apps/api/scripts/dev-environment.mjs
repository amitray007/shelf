#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const environmentPath = '.env.dev';
const contentRoot = './data/dev-content';
const shareSigningKey = randomBytes(32).toString('base64url');
const legacyRendererPublicOrigin = 'http://127.0.0.1:3001';
const rendererPublicOrigin = 'http://localhost:3001';
const rendererPublicOriginAssignment =
  /^([ \t]*(?:export[ \t]+)?SHELF_RENDERER_PUBLIC_ORIGIN[ \t]*=[ \t]*)(["']?)http:\/\/127\.0\.0\.1:3001\2([ \t]*(?:#.*)?)(?=\r?$)/gmu;

const environment = [
  'DATABASE_URL=postgresql:///shelf_dev',
  'SHELF_STORAGE_DRIVER=local',
  `SHELF_STORAGE_LOCAL_ROOT=${contentRoot}`,
  'SHELF_INSTALLATION_ID=installation-dev',
  'SHELF_AUTH_BASE_URL=http://127.0.0.1:5173',
  `SHELF_AUTH_SECRET=${randomBytes(32).toString('base64url')}`,
  `SHELF_SHARE_SIGNING_KEY=${shareSigningKey}`,
  'SHELF_HOST=127.0.0.1',
  'SHELF_PORT=3000',
  'SHELF_RENDERER_APP_ORIGIN=http://127.0.0.1:5173',
  'SHELF_RENDERER_HOST=127.0.0.1',
  'SHELF_RENDERER_PORT=3001',
  `SHELF_RENDERER_PUBLIC_ORIGIN=${rendererPublicOrigin}`,
  '',
].join('\n');

async function replaceEnvironment(contents) {
  const temporaryPath = `${environmentPath}.${randomBytes(8).toString('hex')}.tmp`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, environmentPath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}

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
    let updated = existing;
    if (parsed.SHELF_RENDERER_PUBLIC_ORIGIN === legacyRendererPublicOrigin) {
      updated = updated.replace(
        rendererPublicOriginAssignment,
        (_assignment, prefix, quote, suffix) =>
          `${prefix}${quote}${rendererPublicOrigin}${quote}${suffix}`,
      );
      if (parseEnv(updated).SHELF_RENDERER_PUBLIC_ORIGIN !== rendererPublicOrigin) {
        throw new Error('Could not migrate the legacy SHELF_RENDERER_PUBLIC_ORIGIN value.');
      }
    }
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
      ['SHELF_RENDERER_PUBLIC_ORIGIN', rendererPublicOrigin],
    ]) {
      if (parsed[name] === undefined) additions.push(`${name}=${value}`);
    }
    if (additions.length > 0) {
      const separator = updated.length === 0 || updated.endsWith('\n') ? '' : '\n';
      updated = `${updated}${separator}${additions.join('\n')}\n`;
    }
    if (updated !== existing) {
      await replaceEnvironment(updated);
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
