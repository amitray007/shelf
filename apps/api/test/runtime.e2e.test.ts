import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_runtime_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
const workspaceRoot = resolve(import.meta.dirname, '../../..');
let contentRoot = '';
let runtimeRoot = '';
let sourceFile = '';

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  runtimeRoot = await mkdtemp(join(tmpdir(), 'shelf-runtime-e2e-'));
  contentRoot = join(runtimeRoot, 'content');
  sourceFile = join(runtimeRoot, 'shelf.txt');
  await writeFile(sourceFile, 'durable shelf');
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  await rm(runtimeRoot, { force: true, recursive: true });
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('compiled migrate-to-restart workflow', () => {
  it('publishes, replays, reads pinned bytes after restart, and enforces revocation', async () => {
    const port = await availablePort();
    const password = 'runtime-owner-password-canary';
    const authSecret = 'runtime-auth-secret-canary-at-least-32-characters';
    const environment = {
      ...process.env,
      DATABASE_URL: connectionString,
      SHELF_STORAGE_DRIVER: 'local',
      SHELF_STORAGE_LOCAL_ROOT: contentRoot,
      SHELF_INSTALLATION_ID: 'installation-main',
      SHELF_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
      SHELF_AUTH_SECRET: authSecret,
      SHELF_HOST: '127.0.0.1',
      SHELF_PORT: String(port),
    };

    await expect(
      runAdmin(['migrate'], { ...process.env, DATABASE_URL: connectionString }),
    ).resolves.toMatchObject({ code: 0 });
    const bootstrap = await runAdmin(
      [
        'owner',
        'bootstrap',
        '--email',
        'owner@example.test',
        '--name',
        'Shelf Owner',
        '--password-file',
        '-',
        '--grant',
        'workspace-main:file.publish',
        '--grant',
        'workspace-main:revision.read',
      ],
      environment,
      password,
    );
    expect(bootstrap.code).toBe(0);
    const issued = await runAdmin(
      [
        'credential',
        'issue',
        '--name',
        'runtime-agent',
        '--grant',
        'workspace-main:file.publish',
        '--grant',
        'workspace-main:revision.read',
      ],
      environment,
    );
    const credential = JSON.parse(issued.stdout) as { credentialId: string; token: string };

    let server = await startServer(environment);
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      const first = await publish(endpoint, credential.token, 'runtime-idempotency', environment);
      expect(first.replayed).toBe(false);
      await expect(read(endpoint, credential.token, first.revisionId)).resolves.toBe(
        'durable shelf',
      );

      await stopServer(server);
      server = await startServer(environment);
      const replay = await publish(endpoint, credential.token, 'runtime-idempotency', environment);
      expect(replay).toMatchObject({ revisionId: first.revisionId, replayed: true });
      await expect(read(endpoint, credential.token, first.revisionId)).resolves.toBe(
        'durable shelf',
      );
      const reconciliation = await runAdmin(['reconcile', 'scan'], environment);
      expect(reconciliation.code).toBe(0);
      expect(JSON.parse(reconciliation.stdout)).toMatchObject({
        apiVersion: 'v1',
        mode: 'dry-run',
        summary: {
          referencedContent: 1,
          healthyReferenced: 1,
          missingReferenced: 0,
          sealedOrphanCandidates: 0,
          staleStagingCandidates: 0,
        },
      });

      await expect(
        runAdmin(['credential', 'revoke', '--credential-id', credential.credentialId], environment),
      ).resolves.toMatchObject({ code: 0 });
      await expect(
        publish(endpoint, credential.token, 'revoked-publish', environment),
      ).rejects.toThrow('AUTHENTICATION_REQUIRED');

      const logs = `${server.stdout.join('')} ${server.stderr.join('')} ${bootstrap.stderr}`;
      for (const canary of [
        password,
        credential.token,
        connectionString,
        contentRoot,
        authSecret,
      ]) {
        expect(logs).not.toContain(canary);
      }
    } finally {
      await stopServer(server);
    }
  }, 30_000);
});

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolvePromise) => socket.listen(0, '127.0.0.1', resolvePromise));
  const address = socket.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolvePromise, reject) =>
    socket.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return port;
}

function runAdmin(
  args: string[],
  environment: NodeJS.ProcessEnv,
  stdin = '',
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess('apps/api/dist/operator/cli.js', args, environment, stdin);
}

function runProcess(
  entrypoint: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  stdin = '',
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: workspaceRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(stdin);
  });
}

interface RunningServer {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
}

function startServer(environment: NodeJS.ProcessEnv): Promise<RunningServer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['apps/api/dist/server-cli.js'], {
      cwd: workspaceRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const running: RunningServer = { child, stdout: [], stderr: [] };
    const timeout = setTimeout(() => reject(new Error('Shelf server startup timed out.')), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      running.stdout.push(text);
      if (text.includes('"status":"started"')) {
        clearTimeout(timeout);
        resolvePromise(running);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => running.stderr.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Shelf server exited during startup with ${code}.`));
    });
  });
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error('Shelf server shutdown timed out.')), 10_000);
    server.child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error(`Shelf server shutdown exited with ${code}.`));
    });
  });
}

async function publish(
  endpoint: string,
  token: string,
  idempotencyKey: string,
  environment: NodeJS.ProcessEnv,
) {
  const result = await runProcess(
    'apps/cli/dist/index.js',
    [
      'publish',
      '--url',
      endpoint,
      '--workspace',
      'workspace-main',
      '--file',
      sourceFile,
      '--idempotency-key',
      idempotencyKey,
      '--allow-insecure-loopback',
    ],
    { ...environment, SHELF_TOKEN: token },
  );
  if (result.code !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as { revisionId: string; replayed: boolean };
}

async function read(endpoint: string, token: string, revisionId: string): Promise<string> {
  const response = await fetch(`${endpoint}/api/v1/revisions/${revisionId}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Read returned ${response.status}.`);
  return response.text();
}
