import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runShelfAdmin, type ShelfAdminRuntime } from '../src/operator/cli.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_operator_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
let contentRoot = '';

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  contentRoot = await mkdtemp(join(tmpdir(), 'shelf-operator-integration-'));
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  await rm(contentRoot, { force: true, recursive: true });
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('host-local operator CLI', () => {
  it('migrates, bootstraps, and manages credentials without reprinting secrets', async () => {
    const password = 'owner-password-canary-long-enough';
    const env = {
      DATABASE_URL: connectionString,
      SHELF_STORAGE_DRIVER: 'local',
      SHELF_STORAGE_LOCAL_ROOT: contentRoot,
      SHELF_INSTALLATION_ID: 'installation-main',
      SHELF_AUTH_BASE_URL: 'http://127.0.0.1:3000',
      SHELF_AUTH_SECRET: 'operator-integration-auth-secret-at-least-32-chars',
    };

    expect((await command({ DATABASE_URL: connectionString }, ['migrate'])).code).toBe(0);
    const bootstrap = await command(
      env,
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
      password,
    );
    expect(bootstrap.code).toBe(0);
    expect(bootstrap.combined).not.toContain(password);

    const issued = await command(env, [
      'credential',
      'issue',
      '--name',
      'release-agent',
      '--grant',
      'workspace-main:file.publish',
    ]);
    const issuance = JSON.parse(issued.stdout) as { credentialId: string; token: string };
    expect(issuance.token).toMatch(/^shf_v1\./u);

    const listed = await command(env, ['credential', 'list']);
    expect(listed.stdout).toContain(issuance.credentialId);
    expect(listed.combined).not.toContain(issuance.token);

    const rotated = await command(env, [
      'credential',
      'rotate',
      '--credential-id',
      issuance.credentialId,
    ]);
    const replacement = JSON.parse(rotated.stdout) as { token: string };
    expect(replacement.token).toMatch(/^shf_v1\./u);
    expect(replacement.token).not.toBe(issuance.token);

    const revoked = await command(env, [
      'credential',
      'revoke',
      '--credential-id',
      issuance.credentialId,
    ]);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ revoked: true, alreadyRevoked: false });
    const replay = await command(env, [
      'credential',
      'revoke',
      '--credential-id',
      issuance.credentialId,
    ]);
    expect(JSON.parse(replay.stdout)).toMatchObject({ revoked: true, alreadyRevoked: true });
  });
});

async function command(
  env: ShelfAdminRuntime['env'],
  args: string[],
  stdin = '',
): Promise<{ code: number; stdout: string; stderr: string; combined: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runShelfAdmin(['node', 'shelf-admin', ...args], {
    env,
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    async readStdin() {
      return stdin;
    },
  });
  return {
    code,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    combined: `${stdout.join('')} ${stderr.join('')}`,
  };
}
