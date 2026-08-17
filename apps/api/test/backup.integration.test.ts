import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CommitFolderPublishInput,
  type CommitPublishInput,
  canonicalFolderManifest,
  type StoredPublish,
} from '@shelf/core';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresRevisionRepository,
} from '@shelf/postgres';
import { LocalContentStorage } from '@shelf/storage';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runShelfAdmin } from '../src/operator/cli.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const suffix = randomBytes(8).toString('hex');
const sourceName = `shelf_backup_source_${suffix}`;
const restoreName = `shelf_backup_restore_${suffix}`;
const sourceUrl = databaseUrl(sourceName);
const restoreUrl = databaseUrl(restoreName);
let root = '';

function databaseUrl(name: string): string {
  if (adminConnectionString === undefined) return 'postgresql:///shelf_test_not_configured';
  const value = new URL(adminConnectionString);
  value.pathname = `/${name}`;
  return value.toString();
}

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  root = await mkdtemp(join(tmpdir(), 'shelf-backup-integration-'));
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${sourceName}`);
    await admin.query(`CREATE DATABASE ${restoreName}`);
  } finally {
    await admin.end();
  }
  const source = createPostgresDatabase({ connectionString: sourceUrl });
  await migratePostgresToLatest(source);
  await source.destroy();
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  await rm(root, { force: true, recursive: true });
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${sourceName} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${restoreName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('offline Local File backup and restore', () => {
  it('recovers PostgreSQL metadata and byte-exact immutable content into empty targets', async () => {
    const sourceContentRoot = join(root, 'source-content');
    const restoredContentRoot = join(root, 'restored-content');
    const backupDirectory = join(root, 'backup-one');
    const sourceDatabase = createPostgresDatabase({ connectionString: sourceUrl });
    const sourceRepository = new PostgresRevisionRepository(sourceDatabase);
    const sourceStorage = new LocalContentStorage({ root: sourceContentRoot });
    const staged = await sourceStorage.stage(chunks('recoverable bytes'), {});
    const sealed = await sourceStorage.seal(staged, descriptor('recoverable bytes'));
    const revision = storedRevision(sealed);
    await sourceRepository.commitPublish(publishInput(revision));
    const folderFileStage = await sourceStorage.stage(chunks(''), {});
    const folderFile = await sourceStorage.seal(folderFileStage, descriptor(''));
    const folderEntries = [
      { path: 'empty', kind: 'directory' as const },
      {
        path: 'nested.txt',
        kind: 'file' as const,
        mediaType: 'text/plain',
        content: folderFile,
      },
    ];
    const canonical = canonicalFolderManifest(folderEntries);
    const manifestStage = await sourceStorage.stage(
      (async function* content() {
        yield canonical.bytes;
      })(),
      {},
    );
    const manifest = await sourceStorage.seal(manifestStage, {
      contentHash: canonical.contentHash,
      byteCount: canonical.bytes.byteLength,
    });
    const folderPublish: CommitFolderPublishInput = {
      namespace: {
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        actorId: 'actor-agent',
        operation: 'file.publish',
        key: 'backup-folder',
      },
      fingerprint: `folder-publish-request/v1:sha256:${'b'.repeat(64)}`,
      result: {
        apiVersion: 'v1',
        kind: 'folder',
        installationId: 'installation-main',
        workspaceId: 'workspace-main',
        artifactId: 'art_backup_folder_AAAAAAA',
        revisionId: 'rev_backup_folder_AAAAAAA',
        manifest,
        rootName: 'Project',
        totalByteCount: folderFile.byteCount,
        fileCount: 1,
        provenance: {
          classification: 'direct-publish',
          observed: { actorId: 'actor-agent', operation: 'file.publish' },
        },
        publisherMetadata: {},
      },
      entries: folderEntries,
    };
    await sourceRepository.commitFolderPublish(folderPublish);
    await sourceDatabase.destroy();

    const created = await command(environment(sourceUrl, sourceContentRoot), [
      'backup',
      'create',
      '--output',
      backupDirectory,
      '--confirm-offline',
      'installation-main',
    ]);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      status: 'created',
      backupId: 'backup-one',
      referencedContent: 3,
    });

    const blockedTarget = new Pool({ connectionString: restoreUrl });
    await blockedTarget.query('CREATE TYPE public.restore_blocker AS (value text)');
    const blocked = await command(environment(restoreUrl, restoredContentRoot), [
      'backup',
      'restore',
      '--from',
      backupDirectory,
      '--confirm-offline',
      'installation-main',
    ]);
    await blockedTarget.query('DROP TYPE public.restore_blocker');
    await blockedTarget.end();
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe('');
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: { code: 'ADMIN_FAILED' } });

    const privilegedTarget = new Pool({ connectionString: restoreUrl });
    await privilegedTarget.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    const privilegeBlocked = await command(environment(restoreUrl, restoredContentRoot), [
      'backup',
      'restore',
      '--from',
      backupDirectory,
      '--confirm-offline',
      'installation-main',
    ]);
    await privilegedTarget.query('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM PUBLIC');
    await privilegedTarget.end();
    expect(privilegeBlocked.code).toBe(1);
    expect(privilegeBlocked.stdout).toBe('');
    expect(JSON.parse(privilegeBlocked.stderr)).toMatchObject({
      error: { code: 'ADMIN_FAILED' },
    });

    const restored = await command(environment(restoreUrl, restoredContentRoot), [
      'backup',
      'restore',
      '--from',
      backupDirectory,
      '--confirm-offline',
      'installation-main',
    ]);
    expect(restored.code).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      status: 'restored',
      backupId: 'backup-one',
      referencedContent: 3,
    });

    const restoredDatabase = createPostgresDatabase({ connectionString: restoreUrl });
    const restoredRevision = await new PostgresRevisionRepository(restoredDatabase).findRevision(
      revision.revisionId,
    );
    expect(restoredRevision).toEqual(revision);
    const restoredStorage = new LocalContentStorage({ root: restoredContentRoot });
    await expect(collect(await restoredStorage.read(revision.content, {}))).resolves.toBe(
      'recoverable bytes',
    );
    await expect(collect(await restoredStorage.read(folderFile, {}))).resolves.toBe('');
    await expect(collect(await restoredStorage.read(manifest, {}))).resolves.toBe(
      new TextDecoder().decode(canonical.bytes),
    );
    await expect(
      new PostgresRevisionRepository(restoredDatabase).listFolderEntries({
        installationId: 'installation-main',
        revisionId: folderPublish.result.revisionId,
        limit: 10,
      }),
    ).resolves.toEqual({ items: folderEntries });
    await restoredDatabase.destroy();
  });
});

function environment(databaseUrlValue: string, contentRoot: string) {
  return {
    DATABASE_URL: databaseUrlValue,
    SHELF_STORAGE_DRIVER: 'local',
    SHELF_STORAGE_LOCAL_ROOT: contentRoot,
    SHELF_INSTALLATION_ID: 'installation-main',
  };
}

async function command(environmentValue: Record<string, string>, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runShelfAdmin(['node', 'shelf-admin', ...args], {
    env: environmentValue,
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    async readStdin() {
      return '';
    },
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const values: Uint8Array[] = [];
  for await (const chunk of source) values.push(chunk);
  return Buffer.concat(values).toString('utf8');
}

function descriptor(value: string) {
  return {
    contentHash: `sha256:${createHash('sha256').update(value).digest('hex')}`,
    byteCount: Buffer.byteLength(value),
  };
}

function storedRevision(content: StoredPublish['content']): StoredPublish {
  return {
    apiVersion: 'v1',
    installationId: 'installation-main',
    workspaceId: 'workspace-main',
    artifactId: 'art_backup_AAAAAAAAAAAAAAAA',
    revisionId: 'rev_backup_AAAAAAAAAAAAAAAA',
    content,
    originalFileName: 'backup.txt',
    mediaType: 'text/plain',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-agent', operation: 'file.publish' },
    },
    publisherMetadata: { source: 'backup-integration' },
  };
}

function publishInput(result: StoredPublish): CommitPublishInput {
  return {
    namespace: {
      installationId: result.installationId,
      workspaceId: result.workspaceId,
      actorId: result.provenance.observed.actorId,
      operation: 'file.publish',
      key: 'backup-integration',
    },
    fingerprint: `publish-request/v1:sha256:${'a'.repeat(64)}`,
    result,
  };
}
