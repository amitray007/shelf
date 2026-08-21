import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommitPublishInput, StoredPublish } from '@shelf/core';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresRevisionRepository,
} from '@shelf/postgres';
import { LocalContentStorage } from '@shelf/storage';
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
  const database = createPostgresDatabase({ connectionString });
  await migratePostgresToLatest(database);
  await database.destroy();
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

function operatorEnvironment() {
  return {
    DATABASE_URL: connectionString,
    SHELF_STORAGE_DRIVER: 'local',
    SHELF_STORAGE_LOCAL_ROOT: contentRoot,
    SHELF_INSTALLATION_ID: 'installation-main',
    SHELF_AUTH_BASE_URL: 'http://127.0.0.1:3000',
    SHELF_AUTH_SECRET: 'operator-integration-auth-secret-at-least-32-chars',
    SHELF_SHARE_SIGNING_KEY: 'operator-share-signing-key-at-least-32-chars',
    SHELF_PRIVACY_KEY: 'operator-privacy-key-at-least-32-characters-long',
  };
}

describePostgres('host-local operator CLI', () => {
  it('migrates, bootstraps, and manages credentials without reprinting secrets', async () => {
    const password = 'owner-password-canary-long-enough';
    const env = operatorEnvironment();

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
    const bootstrapped = JSON.parse(bootstrap.stdout) as { actorId: string };

    const replacementPassword = 'replacement-owner-password-canary-long-enough';
    const reset = await command(
      env,
      [
        'owner',
        'reset',
        '--email',
        'renamed-owner@example.test',
        '--name',
        'Renamed Shelf Owner',
        '--password-file',
        '-',
      ],
      replacementPassword,
    );
    expect(reset.code).toBe(0);
    expect(reset.combined).not.toContain(replacementPassword);
    expect(JSON.parse(reset.stdout)).toMatchObject({
      actorId: bootstrapped.actorId,
      email: 'renamed-owner@example.test',
      name: 'Renamed Shelf Owner',
    });

    const createdWorkspace = await command(env, ['workspace', 'create', '--id', 'workspace-work']);
    expect(JSON.parse(createdWorkspace.stdout)).toEqual({
      workspaceId: 'workspace-work',
      actions: ['file.publish', 'revision.read'],
    });
    expect((await command(env, ['workspace', 'create', '--id', 'workspace-work'])).code).toBe(1);
    expect(
      (
        await command(env, [
          'credential',
          'issue',
          '--name',
          'foreign-agent',
          '--grant',
          'workspace-other:file.publish',
        ])
      ).code,
    ).toBe(1);

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

  it('reports reconciliation findings without deleting storage', async () => {
    const env = operatorEnvironment();
    const database = createPostgresDatabase({ connectionString });
    const repository = new PostgresRevisionRepository(database);
    const storage = new LocalContentStorage({ root: contentRoot });
    const healthyStage = await storage.stage(chunks('healthy'), {});
    const healthy = await storage.seal(healthyStage, descriptor('healthy'));
    const orphanStage = await storage.stage(chunks('orphan'), {});
    const orphan = await storage.seal(orphanStage, descriptor('orphan'));
    const stale = await storage.stage(chunks('stale'), {});
    const old = new Date('2020-01-01T00:00:00.000Z');
    await Promise.all([
      utimes(join(contentRoot, 'objects', orphan.contentId), old, old),
      utimes(join(contentRoot, 'staging', `${stale.stageId}.stage`), old, old),
    ]);
    await repository.commitPublish(
      publishInput(
        storedRevision('rev_reconcile_healthy_AAA', 'art_reconcile_healthy_AAA', healthy),
        'reconcile-healthy',
      ),
    );
    const missingContent = {
      contentId: 'cnt_dddddddddddddddddddddddddddddddd',
      contentHash: `sha256:${'d'.repeat(64)}`,
      byteCount: 15,
    };
    await repository.commitPublish(
      publishInput(
        storedRevision('rev_reconcile_missing_BBB', 'art_reconcile_missing_BBB', missingContent),
        'reconcile-missing',
      ),
    );
    await database.destroy();

    const result = await command(env, ['reconcile', 'scan', '--minimum-age-seconds', '3600']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      apiVersion: 'v1',
      mode: 'dry-run',
      installationId: 'installation-main',
      minimumAgeSeconds: 3600,
      summary: {
        referencedContent: 2,
        healthyReferenced: 1,
        missingReferenced: 1,
        sealedOrphanCandidates: 1,
        staleStagingCandidates: 1,
      },
      findings: {
        missingReferenced: [{ contentId: missingContent.contentId }],
        sealedOrphanCandidates: [{ contentId: orphan.contentId }],
        staleStagingCandidates: [{ stageId: stale.stageId }],
      },
    });
    const repeated = await command(env, ['reconcile', 'scan']);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      minimumAgeSeconds: 86_400,
      summary: report.summary,
      findings: report.findings,
    });
    await expect(readdir(join(contentRoot, 'objects'))).resolves.toEqual(
      expect.arrayContaining([healthy.contentId, orphan.contentId]),
    );
    await expect(readdir(join(contentRoot, 'staging'))).resolves.toContain(
      `${stale.stageId}.stage`,
    );
  });
});

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

function descriptor(value: string) {
  return {
    contentHash: `sha256:${createHash('sha256').update(value).digest('hex')}`,
    byteCount: Buffer.byteLength(value),
  };
}

function storedRevision(
  revisionId: string,
  artifactId: string,
  content: StoredPublish['content'],
): StoredPublish {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId,
    revisionId,
    content,
    originalFileName: 'reconciliation.txt',
    mediaType: 'text/plain',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-agent', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'operator-integration' },
  };
}

function publishInput(result: StoredPublish, key: string): CommitPublishInput {
  return {
    namespace: {
      installationId: result.installationId,
      workspaceId: result.workspaceId,
      actorId: result.provenance.observed.actorId,
      operation: 'file.publish',
      key,
    },
    fingerprint: `publish-request/v1:sha256:${createHash('sha256').update(key).digest('hex')}`,
    result,
  };
}

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
