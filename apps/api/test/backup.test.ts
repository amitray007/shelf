import { createHash } from 'node:crypto';

import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalBackup,
  createVerifiedBackupManifest,
  restoreLocalBackup,
} from '../src/operator/backup.js';

const contentId = 'cnt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const bytes = Buffer.from('durable shelf backup');
const roots: string[] = [];
const installations = {
  async listInstallationIds() {
    return ['installation-main'];
  },
};
const verifiedInventory = {
  async inventory() {
    return {
      sealed: [
        { contentId, byteCount: bytes.byteLength, modifiedAt: new Date('2026-08-17T12:00:00Z') },
      ],
      staging: [],
      unrecognizedEntries: 0,
    };
  },
};
const emptyInventory = {
  async inventory() {
    return { sealed: [], staging: [], unrecognizedEntries: 0 };
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function* chunks(): AsyncIterable<Uint8Array> {
  yield bytes.subarray(0, 8);
  yield bytes.subarray(8);
}

describe('backup manifest', () => {
  it('records independently verified referenced content', async () => {
    const manifest = await createVerifiedBackupManifest({
      installationId: 'installation-main',
      createdAt: new Date('2026-08-17T13:00:00.000Z'),
      references: {
        async listReferencedContent() {
          return [
            {
              contentId,
              contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              byteCount: bytes.byteLength,
              revisionCount: 2,
            },
          ];
        },
      },
      content: {
        async read() {
          return chunks();
        },
      },
      inventory: verifiedInventory,
    });

    expect(manifest).toEqual({
      apiVersion: 'shelf.backup/v1',
      installationId: 'installation-main',
      createdAt: '2026-08-17T13:00:00.000Z',
      consistency: { mode: 'offline', writers: 'operator-confirmed-stopped' },
      referencedContent: [
        {
          contentId,
          contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          byteCount: bytes.byteLength,
          revisionCount: 2,
        },
      ],
    });
  });

  it('refuses metadata whose immutable bytes no longer match', async () => {
    await expect(
      createVerifiedBackupManifest({
        installationId: 'installation-main',
        createdAt: new Date('2026-08-17T13:00:00.000Z'),
        references: {
          async listReferencedContent() {
            return [
              {
                contentId,
                contentHash: `sha256:${'f'.repeat(64)}`,
                byteCount: bytes.byteLength,
                revisionCount: 1,
              },
            ];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: verifiedInventory,
      }),
    ).rejects.toThrow('backup verification');
  });

  it('refuses unrecognized Local File entries before following referenced content', async () => {
    let reads = 0;
    await expect(
      createVerifiedBackupManifest({
        installationId: 'installation-main',
        createdAt: new Date('2026-08-17T13:00:00.000Z'),
        references: {
          async listReferencedContent() {
            return [
              {
                contentId,
                contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                byteCount: bytes.byteLength,
                revisionCount: 1,
              },
            ];
          },
        },
        content: {
          async read() {
            reads += 1;
            return chunks();
          },
        },
        inventory: {
          async inventory() {
            return { sealed: [], staging: [], unrecognizedEntries: 1 };
          },
        },
      }),
    ).rejects.toThrow('unrecognized entries');
    expect(reads).toBe(0);
  });

  it('rejects an offline confirmation for another installation before running tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-backup-test-'));
    roots.push(root);
    let commands = 0;

    await expect(
      createLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///unused',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: join(root, 'content'),
        },
        outputDirectory: join(root, 'backup'),
        offlineConfirmation: 'installation-other',
        installations,
        references: {
          async listReferencedContent() {
            return [];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: emptyInventory,
        async runCommand() {
          commands += 1;
          return '';
        },
      }),
    ).rejects.toThrow('offline confirmation');
    expect(commands).toBe(0);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('rejects a database containing another installation before creating a dump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-backup-installation-'));
    roots.push(root);
    const contentRoot = join(root, 'content');
    await mkdir(contentRoot);
    let commands = 0;

    await expect(
      createLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///unused',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: contentRoot,
        },
        outputDirectory: join(root, 'backup'),
        offlineConfirmation: 'installation-main',
        installations: {
          async listInstallationIds() {
            return ['installation-main', 'installation-other'];
          },
        },
        references: {
          async listReferencedContent() {
            return [];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: emptyInventory,
        async runCommand() {
          commands += 1;
          return '';
        },
      }),
    ).rejects.toThrow('another Shelf installation');
    expect(commands).toBe(0);
    await expect(readdir(root)).resolves.toEqual(['content']);
  });

  it('treats a child whose name starts with two dots as overlapping content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-backup-overlap-'));
    roots.push(root);
    const contentRoot = join(root, 'content');
    await mkdir(contentRoot);

    await expect(
      createLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///unused',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: contentRoot,
        },
        outputDirectory: join(contentRoot, '..backup'),
        offlineConfirmation: 'installation-main',
        installations,
        references: {
          async listReferencedContent() {
            return [];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: emptyInventory,
        async runCommand() {
          return '';
        },
      }),
    ).rejects.toThrow('must not overlap');
    await expect(readdir(contentRoot)).resolves.toEqual([]);
  });

  it('rejects overlap reached through a symlinked parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-backup-alias-'));
    roots.push(root);
    const contentRoot = join(root, 'content');
    const contentAlias = join(root, 'content-alias');
    await mkdir(contentRoot);
    await symlink(contentRoot, contentAlias);

    await expect(
      createLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///unused',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: contentRoot,
        },
        outputDirectory: join(contentAlias, 'backup'),
        offlineConfirmation: 'installation-main',
        installations,
        references: {
          async listReferencedContent() {
            return [];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: emptyInventory,
        async runCommand() {
          return '';
        },
      }),
    ).rejects.toThrow('must not overlap');
    await expect(readdir(contentRoot)).resolves.toEqual([]);
  });

  it('creates a checksummed offline bundle without putting the database URL on argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-backup-test-'));
    roots.push(root);
    const contentRoot = join(root, 'content');
    const outputDirectory = join(root, 'backup-one');
    await mkdir(contentRoot);
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await createLocalBackup({
      environment: {
        DATABASE_URL: 'postgresql://backup_user:secret-canary@localhost/shelf_test',
        SHELF_INSTALLATION_ID: 'installation-main',
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: contentRoot,
      },
      outputDirectory,
      offlineConfirmation: 'installation-main',
      installations,
      now: () => new Date('2026-08-17T14:00:00.000Z'),
      references: {
        async listReferencedContent() {
          return [
            {
              contentId,
              contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              byteCount: bytes.byteLength,
              revisionCount: 2,
            },
          ];
        },
      },
      content: {
        async read() {
          return chunks();
        },
      },
      inventory: verifiedInventory,
      async runCommand(request) {
        commands.push({ command: request.command, args: request.args });
        if (request.outputPath === undefined) throw new Error('Expected protected output.');
        await writeFile(
          request.outputPath,
          request.command === 'pg_dump' ? 'postgres-dump' : 'content-archive',
        );
        return '';
      },
    });

    expect(result).toEqual({
      apiVersion: 'v1',
      status: 'created',
      backupId: 'backup-one',
      referencedContent: 1,
    });
    const manifest = JSON.parse(await readFile(join(outputDirectory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      apiVersion: 'shelf.backup/v1',
      installationId: 'installation-main',
      createdAt: '2026-08-17T14:00:00.000Z',
      archives: {
        metadata: {
          file: 'metadata.dump',
          format: 'postgresql-custom',
          contentHash: `sha256:${createHash('sha256').update('postgres-dump').digest('hex')}`,
        },
        content: {
          file: 'content.tar',
          format: 'local-tar',
          contentHash: `sha256:${createHash('sha256').update('content-archive').digest('hex')}`,
        },
      },
    });
    expect(commands.map((command) => command.command)).toEqual(['pg_dump', 'tar']);
    expect(JSON.stringify(commands)).not.toContain('secret-canary');
    await expect(
      Promise.all(
        ['metadata.dump', 'content.tar', 'manifest.json'].map(async (file) =>
          ((await stat(join(outputDirectory, file))).mode & 0o777).toString(8),
        ),
      ),
    ).resolves.toEqual(['600', '600', '600']);
    expect(((await stat(outputDirectory)).mode & 0o777).toString(8)).toBe('700');
  });

  it('restores a verified bundle only into empty PostgreSQL and absent local content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-restore-test-'));
    roots.push(root);
    const inputDirectory = join(root, 'backup-one');
    const contentRoot = join(root, 'restored-content');
    await mkdir(inputDirectory);
    const metadata = Buffer.from('postgres-dump');
    const contentArchive = Buffer.from('content-archive');
    await Promise.all([
      writeFile(join(inputDirectory, 'metadata.dump'), metadata),
      writeFile(join(inputDirectory, 'content.tar'), contentArchive),
    ]);
    await writeFile(
      join(inputDirectory, 'manifest.json'),
      `${JSON.stringify({
        apiVersion: 'shelf.backup/v1',
        installationId: 'installation-main',
        createdAt: '2026-08-17T14:00:00.000Z',
        consistency: { mode: 'offline', writers: 'operator-confirmed-stopped' },
        referencedContent: [
          {
            contentId,
            contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            byteCount: bytes.byteLength,
            revisionCount: 2,
          },
        ],
        archives: {
          metadata: {
            file: 'metadata.dump',
            format: 'postgresql-custom',
            contentHash: `sha256:${createHash('sha256').update(metadata).digest('hex')}`,
          },
          content: {
            file: 'content.tar',
            format: 'local-tar',
            contentHash: `sha256:${createHash('sha256').update(contentArchive).digest('hex')}`,
          },
        },
      })}\n`,
    );
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await restoreLocalBackup({
      environment: {
        DATABASE_URL: 'postgresql://restore_user:secret-canary@localhost/shelf_restore',
        SHELF_INSTALLATION_ID: 'installation-main',
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: contentRoot,
      },
      inputDirectory,
      offlineConfirmation: 'installation-main',
      installations,
      references: {
        async listReferencedContent() {
          return [
            {
              contentId,
              contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              byteCount: bytes.byteLength,
              revisionCount: 2,
            },
          ];
        },
      },
      content: {
        async read() {
          return chunks();
        },
      },
      inventory: verifiedInventory,
      async assertMetadataCurrent() {},
      async runCommand(request) {
        commands.push({ command: request.command, args: request.args });
        return request.command === 'psql' ? '0\n' : '';
      },
    });

    expect(result).toEqual({
      apiVersion: 'v1',
      status: 'restored',
      backupId: 'backup-one',
      referencedContent: 1,
    });
    expect(commands.map((command) => command.command)).toEqual(['psql', 'tar', 'pg_restore']);
    expect(JSON.stringify(commands)).not.toContain('secret-canary');
  });

  it('rejects a changed archive before touching an empty restore target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-restore-checksum-'));
    roots.push(root);
    const sourceContentRoot = join(root, 'source-content');
    const targetContentRoot = join(root, 'target-content');
    const backupDirectory = join(root, 'backup-one');
    await mkdir(sourceContentRoot);
    const references = {
      async listReferencedContent() {
        return [
          {
            contentId,
            contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            byteCount: bytes.byteLength,
            revisionCount: 1,
          },
        ];
      },
    };
    const content = {
      async read() {
        return chunks();
      },
    };
    await createLocalBackup({
      environment: {
        DATABASE_URL: 'postgresql:///shelf_source',
        SHELF_INSTALLATION_ID: 'installation-main',
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: sourceContentRoot,
      },
      outputDirectory: backupDirectory,
      offlineConfirmation: 'installation-main',
      installations,
      references,
      content,
      inventory: verifiedInventory,
      async runCommand(request) {
        if (request.outputPath === undefined) throw new Error('Expected protected output.');
        await writeFile(request.outputPath, request.command);
        return '';
      },
    });
    await appendFile(join(backupDirectory, 'content.tar'), 'changed');
    let commands = 0;

    await expect(
      restoreLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///shelf_target',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: targetContentRoot,
        },
        inputDirectory: backupDirectory,
        offlineConfirmation: 'installation-main',
        installations,
        references,
        content,
        inventory: verifiedInventory,
        async assertMetadataCurrent() {},
        async runCommand() {
          commands += 1;
          return '';
        },
      }),
    ).rejects.toThrow('checksum');
    expect(commands).toBe(0);
  });

  it('refuses restore when PostgreSQL already contains user-defined objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-restore-nonempty-'));
    roots.push(root);
    const sourceContentRoot = join(root, 'source-content');
    const targetContentRoot = join(root, 'target-content');
    const backupDirectory = join(root, 'backup-one');
    await mkdir(sourceContentRoot);
    const references = {
      async listReferencedContent() {
        return [];
      },
    };
    const content = {
      async read() {
        return chunks();
      },
    };
    await createLocalBackup({
      environment: {
        DATABASE_URL: 'postgresql:///shelf_source',
        SHELF_INSTALLATION_ID: 'installation-main',
        SHELF_STORAGE_DRIVER: 'local',
        SHELF_STORAGE_LOCAL_ROOT: sourceContentRoot,
      },
      outputDirectory: backupDirectory,
      offlineConfirmation: 'installation-main',
      installations,
      references,
      content,
      inventory: emptyInventory,
      async runCommand(request) {
        if (request.outputPath === undefined) throw new Error('Expected protected output.');
        await writeFile(request.outputPath, request.command);
        return '';
      },
    });
    const commands: string[] = [];

    await expect(
      restoreLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///shelf_target',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: targetContentRoot,
        },
        inputDirectory: backupDirectory,
        offlineConfirmation: 'installation-main',
        installations,
        references,
        content,
        inventory: emptyInventory,
        async assertMetadataCurrent() {},
        async runCommand(request) {
          commands.push(request.command);
          return '3\n';
        },
      }),
    ).rejects.toThrow('database must be empty');
    expect(commands).toEqual(['psql']);
    expect(await readdir(root)).not.toContain('target-content');
  });

  it('refuses restore before reading the backup when the content root already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-restore-existing-content-'));
    roots.push(root);
    const contentRoot = join(root, 'content');
    await mkdir(contentRoot);
    let commands = 0;

    await expect(
      restoreLocalBackup({
        environment: {
          DATABASE_URL: 'postgresql:///shelf_target',
          SHELF_INSTALLATION_ID: 'installation-main',
          SHELF_STORAGE_DRIVER: 'local',
          SHELF_STORAGE_LOCAL_ROOT: contentRoot,
        },
        inputDirectory: join(root, 'backup'),
        offlineConfirmation: 'installation-main',
        installations,
        references: {
          async listReferencedContent() {
            return [];
          },
        },
        content: {
          async read() {
            return chunks();
          },
        },
        inventory: emptyInventory,
        async assertMetadataCurrent() {},
        async runCommand() {
          commands += 1;
          return '';
        },
      }),
    ).rejects.toThrow('content root must not already exist');
    expect(commands).toBe(0);
  });
});
