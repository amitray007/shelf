import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from 'pg';
import { afterEach, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const devEnvironmentScript = fileURLToPath(
  new URL('../scripts/dev-environment.mjs', import.meta.url),
);
const devDatabaseScript = fileURLToPath(new URL('../scripts/dev-database.mjs', import.meta.url));
const devRunnerScript = fileURLToPath(new URL('../scripts/dev-runner.mjs', import.meta.url));
const rendererEnvironmentScript = fileURLToPath(
  new URL('../scripts/renderer-environment.mjs', import.meta.url),
);
const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const testPostgres = adminConnectionString === undefined ? test.skip : test;
const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/shelf-dev-`);
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { force: true, recursive: true })));
  temporaryRoots.clear();
});

test('development setup creates a private local environment and content directory', async () => {
  const root = await temporaryRoot();

  const { stdout, stderr } = await execFileAsync(process.execPath, [devEnvironmentScript], {
    cwd: root,
  });

  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toEqual({ status: 'created', path: '.env.dev' });

  const environment = await readFile(`${root}/.env.dev`, 'utf8');
  expect(environment).toMatch(/^DATABASE_URL=postgresql:\/\/\/shelf_dev$/mu);
  expect(environment).toMatch(/^SHELF_STORAGE_DRIVER=local$/mu);
  expect(environment).toMatch(/^SHELF_STORAGE_LOCAL_ROOT=\.\/data\/dev-content$/mu);
  expect(environment).toMatch(/^SHELF_INSTALLATION_ID=installation-dev$/mu);
  expect(environment).toMatch(/^SHELF_AUTH_BASE_URL=http:\/\/127\.0\.0\.1:3000$/mu);
  expect(environment).toMatch(/^SHELF_AUTH_SECRET=[A-Za-z0-9_-]{43}$/mu);
  expect(environment).toMatch(/^SHELF_SHARE_SIGNING_KEY=[A-Za-z0-9_-]{43}$/mu);
  expect(environment).toMatch(/^SHELF_HOST=127\.0\.0\.1$/mu);
  expect(environment).toMatch(/^SHELF_PORT=3000$/mu);

  expect((await stat(`${root}/.env.dev`)).mode & 0o777).toBe(0o600);
  expect((await stat(`${root}/data/dev-content`)).isDirectory()).toBe(true);
});

test('development setup preserves existing values while adding a missing share signing key', async () => {
  const root = await temporaryRoot();
  const existing = [
    'DATABASE_URL=postgresql:///my_existing_database',
    'SHELF_STORAGE_LOCAL_ROOT=./custom-content',
    '',
  ].join('\n');
  await writeFile(`${root}/.env.dev`, existing, { mode: 0o600 });

  const { stdout, stderr } = await execFileAsync(process.execPath, [devEnvironmentScript], {
    cwd: root,
  });

  expect(stderr).toBe('');
  expect(JSON.parse(stdout)).toEqual({ status: 'updated', path: '.env.dev' });
  const updated = await readFile(`${root}/.env.dev`, 'utf8');
  expect(updated.startsWith(existing)).toBe(true);
  expect(updated).toMatch(/^SHELF_SHARE_SIGNING_KEY=[A-Za-z0-9_-]{43}$/mu);
  expect((await stat(`${root}/custom-content`)).isDirectory()).toBe(true);
  await expect(stat(`${root}/data/dev-content`)).rejects.toMatchObject({ code: 'ENOENT' });
});

testPostgres('development setup creates the local database once without resetting it', async () => {
  const databaseName = `shelf_dev_workflow_${randomBytes(8).toString('hex')}`;
  const connectionUrl = new URL(adminConnectionString as string);
  connectionUrl.pathname = `/${databaseName}`;
  const env = { ...process.env, DATABASE_URL: connectionUrl.toString() };

  try {
    const first = await execFileAsync(process.execPath, [devDatabaseScript], { env });
    expect(first.stderr).toBe('');
    expect(JSON.parse(first.stdout)).toEqual({ status: 'created', database: databaseName });

    const database = new Pool({ connectionString: connectionUrl.toString() });
    try {
      await database.query('CREATE TABLE setup_canary (value text NOT NULL)');
      await database.query("INSERT INTO setup_canary (value) VALUES ('preserved')");
    } finally {
      await database.end();
    }

    const second = await execFileAsync(process.execPath, [devDatabaseScript], { env });
    expect(second.stderr).toBe('');
    expect(JSON.parse(second.stdout)).toEqual({ status: 'exists', database: databaseName });

    const verification = new Pool({ connectionString: connectionUrl.toString() });
    try {
      await expect(verification.query('SELECT value FROM setup_canary')).resolves.toMatchObject({
        rows: [{ value: 'preserved' }],
      });
    } finally {
      await verification.end();
    }
  } finally {
    const admin = new Pool({ connectionString: adminConnectionString });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});

test('development server directs an unprepared checkout to the setup command', async () => {
  const root = await temporaryRoot();

  await expect(
    execFileAsync(process.execPath, [devRunnerScript, '--check'], { cwd: root }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: `${JSON.stringify({ error: 'Run pnpm dev:setup before pnpm dev.' })}\n`,
  });
});

test('development preflight rejects an environment missing renderer authority', async () => {
  const root = await temporaryRoot();
  await mkdir(`${root}/apps/api/dist`, { recursive: true });
  await mkdir(`${root}/apps/web`, { recursive: true });
  await Promise.all([
    writeFile(`${root}/apps/api/dist/server-cli.js`, ''),
    writeFile(`${root}/apps/api/dist/renderer-cli.js`, ''),
    writeFile(`${root}/apps/web/index.html`, ''),
    writeFile(
      `${root}/.env.dev`,
      [
        'DATABASE_URL=postgresql:///shelf_dev',
        'SHELF_STORAGE_DRIVER=local',
        `SHELF_SHARE_SIGNING_KEY=${'s'.repeat(43)}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    ),
  ]);

  await expect(
    execFileAsync(process.execPath, [devRunnerScript, '--check'], { cwd: root }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: `${JSON.stringify({ error: 'Run pnpm dev:setup before pnpm dev.' })}\n`,
  });
});

test('development preflight accepts a share signing key file', async () => {
  const root = await temporaryRoot();
  await mkdir(`${root}/apps/api/dist`, { recursive: true });
  await mkdir(`${root}/apps/web`, { recursive: true });
  await Promise.all([
    writeFile(`${root}/apps/api/dist/server-cli.js`, ''),
    writeFile(`${root}/apps/api/dist/renderer-cli.js`, ''),
    writeFile(`${root}/apps/web/index.html`, ''),
    writeFile(`${root}/share-signing-key`, 's'.repeat(43), { mode: 0o600 }),
    writeFile(
      `${root}/.env.dev`,
      [
        'DATABASE_URL=postgresql:///shelf_dev',
        'SHELF_STORAGE_DRIVER=local',
        'SHELF_SHARE_SIGNING_KEY_FILE=./share-signing-key',
        'SHELF_RENDERER_APP_ORIGIN=http://127.0.0.1:5173',
        'SHELF_RENDERER_PUBLIC_ORIGIN=http://127.0.0.1:3001',
        '',
      ].join('\n'),
      { mode: 0o600 },
    ),
  ]);

  await expect(
    execFileAsync(process.execPath, [devRunnerScript, '--check'], { cwd: root }),
  ).resolves.toMatchObject({
    stdout: `${JSON.stringify({ status: 'ready' })}\n`,
    stderr: '',
  });
});

test('development renderer receives only its explicit data-plane environment', async () => {
  const secret = 'authentication-secret-canary';
  const expression = `import { rendererEnvironment } from ${JSON.stringify(`file://${rendererEnvironmentScript}`)}; process.stdout.write(JSON.stringify(rendererEnvironment(process.env)));`;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '--eval', expression],
    {
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql:///shelf_dev',
        SHELF_SHARE_SIGNING_KEY: 's'.repeat(43),
        SHELF_RENDERER_APP_ORIGIN: 'http://127.0.0.1:5173',
        SHELF_AUTH_SECRET: secret,
        SHELF_AUTH_SECRET_FILE: `/tmp/${secret}`,
        UNRELATED_SECRET: secret,
      },
    },
  );

  expect(stderr).toBe('');
  const environment = JSON.parse(stdout) as Record<string, string>;
  expect(environment).toMatchObject({
    DATABASE_URL: 'postgresql:///shelf_dev',
    SHELF_SHARE_SIGNING_KEY: 's'.repeat(43),
    SHELF_RENDERER_APP_ORIGIN: 'http://127.0.0.1:5173',
  });
  expect(JSON.stringify(environment)).not.toContain(secret);
  expect(environment).not.toHaveProperty('SHELF_AUTH_SECRET');
  expect(environment).not.toHaveProperty('SHELF_AUTH_SECRET_FILE');
  expect(environment).not.toHaveProperty('UNRELATED_SECRET');
});
