#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

import { rendererEnvironment } from './renderer-environment.mjs';

const requiredPaths = [
  '.env.dev',
  'apps/api/dist/server-cli.js',
  'apps/api/dist/renderer-cli.js',
  'apps/web/index.html',
];

try {
  await Promise.all(requiredPaths.map((path) => access(path)));
} catch {
  process.stderr.write(`${JSON.stringify({ error: 'Run pnpm dev:setup before pnpm dev.' })}\n`);
  process.exit(1);
}

loadEnvFile('.env.dev');
const requiredEnvironment = [
  'DATABASE_URL',
  'SHELF_STORAGE_DRIVER',
  'SHELF_RENDERER_APP_ORIGIN',
  'SHELF_RENDERER_PUBLIC_ORIGIN',
];
if (
  requiredEnvironment.some((name) => process.env[name] === undefined || process.env[name] === '') ||
  [process.env.SHELF_SHARE_SIGNING_KEY, process.env.SHELF_SHARE_SIGNING_KEY_FILE].every(
    (value) => value === undefined || value === '',
  )
) {
  process.stderr.write(`${JSON.stringify({ error: 'Run pnpm dev:setup before pnpm dev.' })}\n`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  process.stdout.write(`${JSON.stringify({ status: 'ready' })}\n`);
  process.exit(0);
}

const projects = [
  'packages/contracts',
  'packages/core',
  'packages/auth',
  'packages/postgres',
  'packages/storage',
  'apps/renderer',
  'apps/api',
  'apps/cli',
  'apps/web',
];
const compiler = spawn(
  'pnpm',
  ['exec', 'tsc', '-b', ...projects, '--watch', '--preserveWatchOutput'],
  { stdio: 'inherit' },
);
const server = spawn(
  process.execPath,
  ['--watch', '--env-file=.env.dev', 'apps/api/dist/server-cli.js'],
  { stdio: 'inherit' },
);
const renderer = spawn(process.execPath, ['--watch', 'apps/api/dist/renderer-cli.js'], {
  stdio: 'inherit',
  env: rendererEnvironment(process.env),
});
const web = spawn('pnpm', ['--filter', '@shelf/web', 'dev'], {
  stdio: 'inherit',
});
const children = [compiler, server, renderer, web];
let stopping = false;

function stop(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const child of children) {
  child.once('error', () => stop('SIGTERM', 1));
  child.once('exit', (code, signal) => {
    if (!stopping) {
      const expectedSignal = signal === 'SIGINT' || signal === 'SIGTERM';
      stop('SIGTERM', expectedSignal ? 0 : (code ?? 1));
    }
  });
}
process.once('SIGINT', () => stop('SIGINT', 0));
process.once('SIGTERM', () => stop('SIGTERM', 0));
