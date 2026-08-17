import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  ContentInventory,
  ContentReader,
  ReferencedContent,
  ReferencedContentInventory,
} from '@shelf/core';
import type { InstallationInventory } from '@shelf/postgres';

import { installationIdFromEnvironment, type ShelfEnvironment } from '../environment.js';
import { shelfPersistenceConfigFromEnv } from '../persistence-env.js';

export interface ShelfBackupManifest {
  apiVersion: 'shelf.backup/v1';
  installationId: string;
  createdAt: string;
  consistency: {
    mode: 'offline';
    writers: 'operator-confirmed-stopped';
  };
  referencedContent: ReferencedContent[];
}

export interface ShelfBackupBundleManifest extends ShelfBackupManifest {
  archives: {
    metadata: {
      file: 'metadata.dump';
      format: 'postgresql-custom';
      contentHash: string;
    };
    content: {
      file: 'content.tar';
      format: 'local-tar';
      contentHash: string;
    };
  };
}

export interface BackupCommandRequest {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  inputPath?: string;
  outputPath?: string;
}

export type BackupCommandRunner = (request: BackupCommandRequest) => Promise<string>;

export const runBackupCommand: BackupCommandRunner = async (request) => {
  const input = request.inputPath === undefined ? undefined : await open(request.inputPath, 'r');
  const output =
    request.outputPath === undefined ? undefined : await open(request.outputPath, 'wx', 0o600);
  try {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const child = spawn(request.command, request.args, {
        env: request.environment,
        stdio: [input?.fd ?? 'ignore', output?.fd ?? 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 64 * 1024) {
          child.kill('SIGTERM');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.resume();
      child.once('error', () => {
        if (settled) return;
        settled = true;
        rejectPromise(new Error('A required backup tool could not be started.'));
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0 || stdoutBytes > 64 * 1024) {
          rejectPromise(new Error('A required backup tool failed.'));
          return;
        }
        resolvePromise(Buffer.concat(stdout).toString('utf8'));
      });
    });
  } finally {
    await Promise.all([input?.close(), output?.close()]);
  }
};

function containsPath(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === '' ||
    (candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate))
  );
}

async function canonicalNewPath(path: string): Promise<string> {
  const resolved = resolve(path);
  return resolve(await realpath(dirname(resolved)), basename(resolved));
}

async function assertExclusiveInstallation(
  inventory: InstallationInventory,
  installationId: string,
): Promise<void> {
  const installationIds = await inventory.listInstallationIds();
  if (
    installationIds.length > 1 ||
    (installationIds.length === 1 && installationIds[0] !== installationId)
  ) {
    throw new Error('The database contains another Shelf installation.');
  }
}

function postgresCommandEnvironment(
  connectionString: string,
  environment: ShelfEnvironment,
): NodeJS.ProcessEnv {
  const connection = new URL(connectionString);
  if (connection.protocol !== 'postgres:' && connection.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  const database = decodeURIComponent(connection.pathname.slice(1));
  if (database.length === 0 || database.includes('/') || database.includes('\u0000')) {
    throw new Error('DATABASE_URL must name one database.');
  }
  const commandEnvironment: NodeJS.ProcessEnv = {
    PATH: environment.PATH ?? process.env.PATH,
    PGDATABASE: database,
  };
  for (const name of ['HOME', 'LANG', 'LC_ALL', 'TMPDIR'] as const) {
    const value = environment[name] ?? process.env[name];
    if (value !== undefined) commandEnvironment[name] = value;
  }
  const host = decodeURIComponent(connection.searchParams.get('host') ?? connection.hostname);
  if (host.length > 0) {
    commandEnvironment.PGHOST =
      host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  }
  if (connection.port.length > 0) commandEnvironment.PGPORT = connection.port;
  if (connection.username.length > 0) {
    commandEnvironment.PGUSER = decodeURIComponent(connection.username);
  }
  if (connection.password.length > 0) {
    commandEnvironment.PGPASSWORD = decodeURIComponent(connection.password);
  }
  const postgresOptions: Readonly<Record<string, string>> = {
    application_name: 'PGAPPNAME',
    connect_timeout: 'PGCONNECT_TIMEOUT',
    options: 'PGOPTIONS',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    target_session_attrs: 'PGTARGETSESSIONATTRS',
  };
  for (const [parameter, variable] of Object.entries(postgresOptions)) {
    const value = connection.searchParams.get(parameter);
    if (value !== null) commandEnvironment[variable] = value;
  }
  return commandEnvironment;
}

async function contentHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function writeManifest(path: string, manifest: ShelfBackupBundleManifest): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`The backup ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`The backup ${label} is invalid.`);
  return expected;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`The backup ${label} is invalid.`);
  }
  return value;
}

function parseBackupManifest(value: unknown): ShelfBackupBundleManifest {
  const manifest = requireRecord(value, 'manifest');
  requireLiteral(manifest.apiVersion, 'shelf.backup/v1', 'API version');
  if (typeof manifest.installationId !== 'string') {
    throw new Error('The backup installation ID is invalid.');
  }
  if (
    typeof manifest.createdAt !== 'string' ||
    new Date(manifest.createdAt).toISOString() !== manifest.createdAt
  ) {
    throw new Error('The backup creation time is invalid.');
  }
  const consistency = requireRecord(manifest.consistency, 'consistency declaration');
  requireLiteral(consistency.mode, 'offline', 'consistency mode');
  requireLiteral(
    consistency.writers,
    'operator-confirmed-stopped',
    'writer consistency declaration',
  );
  if (!Array.isArray(manifest.referencedContent)) {
    throw new Error('The backup referenced-content manifest is invalid.');
  }
  const referencedContent = manifest.referencedContent.map((value) => {
    const reference = requireRecord(value, 'content reference');
    if (
      typeof reference.contentId !== 'string' ||
      !/^cnt_[a-f0-9]{32}$/u.test(reference.contentId) ||
      !Number.isSafeInteger(reference.byteCount) ||
      (reference.byteCount as number) < 0 ||
      !Number.isSafeInteger(reference.revisionCount) ||
      (reference.revisionCount as number) <= 0
    ) {
      throw new Error('The backup content reference is invalid.');
    }
    return {
      contentId: reference.contentId,
      contentHash: requireHash(reference.contentHash, 'content reference hash'),
      byteCount: reference.byteCount as number,
      revisionCount: reference.revisionCount as number,
    };
  });
  referencedContent.sort((left, right) => left.contentId.localeCompare(right.contentId));
  if (
    new Set(referencedContent.map((entry) => entry.contentId)).size !== referencedContent.length
  ) {
    throw new Error('The backup contains duplicate content references.');
  }
  const archives = requireRecord(manifest.archives, 'archives declaration');
  const metadata = requireRecord(archives.metadata, 'metadata archive');
  const content = requireRecord(archives.content, 'content archive');
  return {
    apiVersion: 'shelf.backup/v1',
    installationId: manifest.installationId,
    createdAt: manifest.createdAt,
    consistency: { mode: 'offline', writers: 'operator-confirmed-stopped' },
    referencedContent,
    archives: {
      metadata: {
        file: requireLiteral(metadata.file, 'metadata.dump', 'metadata archive name'),
        format: requireLiteral(metadata.format, 'postgresql-custom', 'metadata archive format'),
        contentHash: requireHash(metadata.contentHash, 'metadata archive hash'),
      },
      content: {
        file: requireLiteral(content.file, 'content.tar', 'content archive name'),
        format: requireLiteral(content.format, 'local-tar', 'content archive format'),
        contentHash: requireHash(content.contentHash, 'content archive hash'),
      },
    },
  };
}

export async function createVerifiedBackupManifest(options: {
  installationId: string;
  createdAt: Date;
  references: ReferencedContentInventory;
  content: ContentReader;
  inventory: ContentInventory;
}): Promise<ShelfBackupManifest> {
  const references = await options.references.listReferencedContent(options.installationId);
  references.sort((left, right) => left.contentId.localeCompare(right.contentId));
  const inventory = await options.inventory.inventory();
  if (inventory.unrecognizedEntries !== 0) {
    throw new Error('Local File storage contains unrecognized entries.');
  }
  const sealed = new Map(inventory.sealed.map((entry) => [entry.contentId, entry]));
  if (sealed.size !== inventory.sealed.length) {
    throw new Error('Local File storage contains duplicate content identities.');
  }

  for (const reference of references) {
    const stored = sealed.get(reference.contentId);
    if (stored === undefined || stored.byteCount !== reference.byteCount) {
      throw new Error('Referenced content failed backup verification.');
    }
    const source = await options.content.read(reference, {});
    const hash = createHash('sha256');
    let byteCount = 0;
    for await (const chunk of source) {
      hash.update(chunk);
      byteCount += chunk.byteLength;
      if (!Number.isSafeInteger(byteCount)) throw new Error('Backup content is too large.');
    }
    const contentHash = `sha256:${hash.digest('hex')}`;
    if (byteCount !== reference.byteCount || contentHash !== reference.contentHash) {
      throw new Error('Referenced content failed backup verification.');
    }
  }

  return {
    apiVersion: 'shelf.backup/v1',
    installationId: options.installationId,
    createdAt: options.createdAt.toISOString(),
    consistency: { mode: 'offline', writers: 'operator-confirmed-stopped' },
    referencedContent: references,
  };
}

export async function createLocalBackup(options: {
  environment: ShelfEnvironment;
  outputDirectory: string;
  offlineConfirmation: string;
  runCommand: BackupCommandRunner;
  installations: InstallationInventory;
  references: ReferencedContentInventory;
  content: ContentReader;
  inventory: ContentInventory;
  now?: () => Date;
}): Promise<{
  apiVersion: 'v1';
  status: 'created';
  backupId: string;
  referencedContent: number;
}> {
  const installationId = installationIdFromEnvironment(options.environment);
  if (options.offlineConfirmation !== installationId) {
    throw new Error('The offline confirmation does not match this installation.');
  }
  const config = shelfPersistenceConfigFromEnv(options.environment);
  if (config.content.driver !== 'local') {
    throw new Error('This backup workflow requires Local File storage.');
  }
  const configuredContentRoot = resolve(config.content.root);
  const contentStats = await lstat(configuredContentRoot);
  if (!contentStats.isDirectory()) throw new Error('The Local File storage root is invalid.');
  const contentRoot = await realpath(configuredContentRoot);
  const outputDirectory = await canonicalNewPath(options.outputDirectory);
  if (containsPath(contentRoot, outputDirectory) || containsPath(outputDirectory, contentRoot)) {
    throw new Error('The backup directory and content root must not overlap.');
  }
  try {
    await lstat(outputDirectory);
    throw new Error('The backup directory already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const databaseEnvironment = postgresCommandEnvironment(
    config.postgres.connectionString,
    options.environment,
  );
  await assertExclusiveInstallation(options.installations, installationId);
  const snapshot = await createVerifiedBackupManifest({
    installationId,
    createdAt: options.now?.() ?? new Date(),
    references: options.references,
    content: options.content,
    inventory: options.inventory,
  });
  await mkdir(outputDirectory, { mode: 0o700 });
  const metadataPath = resolve(outputDirectory, 'metadata.dump');
  const contentPath = resolve(outputDirectory, 'content.tar');
  try {
    await options.runCommand({
      command: 'pg_dump',
      args: ['--format=custom', '--no-owner', '--no-privileges', '--serializable-deferrable'],
      environment: databaseEnvironment,
      outputPath: metadataPath,
    });
    await chmod(metadataPath, 0o600);
    await options.runCommand({
      command: 'tar',
      args: ['-C', contentRoot, '-cf', '-', '.'],
      environment: { PATH: options.environment.PATH ?? process.env.PATH },
      outputPath: contentPath,
    });
    await chmod(contentPath, 0o600);

    const after = await createVerifiedBackupManifest({
      installationId,
      createdAt: new Date(snapshot.createdAt),
      references: options.references,
      content: options.content,
      inventory: options.inventory,
    });
    await assertExclusiveInstallation(options.installations, installationId);
    if (JSON.stringify(after.referencedContent) !== JSON.stringify(snapshot.referencedContent)) {
      throw new Error('Shelf metadata changed during backup.');
    }
    const manifest: ShelfBackupBundleManifest = {
      ...snapshot,
      archives: {
        metadata: {
          file: 'metadata.dump',
          format: 'postgresql-custom',
          contentHash: await contentHash(metadataPath),
        },
        content: {
          file: 'content.tar',
          format: 'local-tar',
          contentHash: await contentHash(contentPath),
        },
      },
    };
    await writeManifest(resolve(outputDirectory, 'manifest.json'), manifest);
    return {
      apiVersion: 'v1',
      status: 'created',
      backupId: basename(outputDirectory),
      referencedContent: manifest.referencedContent.length,
    };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreLocalBackup(options: {
  environment: ShelfEnvironment;
  inputDirectory: string;
  offlineConfirmation: string;
  runCommand: BackupCommandRunner;
  installations: InstallationInventory;
  references: ReferencedContentInventory;
  content: ContentReader;
  inventory: ContentInventory;
  assertMetadataCurrent: () => Promise<void>;
}): Promise<{
  apiVersion: 'v1';
  status: 'restored';
  backupId: string;
  referencedContent: number;
}> {
  const installationId = installationIdFromEnvironment(options.environment);
  if (options.offlineConfirmation !== installationId) {
    throw new Error('The offline confirmation does not match this installation.');
  }
  const config = shelfPersistenceConfigFromEnv(options.environment);
  if (config.content.driver !== 'local') {
    throw new Error('This restore workflow requires Local File storage.');
  }
  const configuredContentRoot = resolve(config.content.root);
  try {
    await lstat(configuredContentRoot);
    throw new Error('The restore content root must not already exist.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const contentRoot = await canonicalNewPath(configuredContentRoot);
  const configuredInputDirectory = resolve(options.inputDirectory);
  const inputStats = await lstat(configuredInputDirectory);
  if (!inputStats.isDirectory()) throw new Error('The backup directory is invalid.');
  const inputDirectory = await realpath(configuredInputDirectory);
  if (containsPath(contentRoot, inputDirectory) || containsPath(inputDirectory, contentRoot)) {
    throw new Error('The backup directory and content root must not overlap.');
  }
  const manifest = parseBackupManifest(
    JSON.parse(await readFile(resolve(inputDirectory, 'manifest.json'), 'utf8')),
  );
  if (manifest.installationId !== installationId) {
    throw new Error('The backup belongs to another installation.');
  }
  const metadataPath = resolve(inputDirectory, manifest.archives.metadata.file);
  const contentPath = resolve(inputDirectory, manifest.archives.content.file);
  const [actualMetadataHash, actualContentHash] = await Promise.all([
    contentHash(metadataPath),
    contentHash(contentPath),
  ]);
  if (
    actualMetadataHash !== manifest.archives.metadata.contentHash ||
    actualContentHash !== manifest.archives.content.contentHash
  ) {
    throw new Error('A backup archive checksum does not match its manifest.');
  }

  const databaseEnvironment = postgresCommandEnvironment(
    config.postgres.connectionString,
    options.environment,
  );
  const userObjectCount = await options.runCommand({
    command: 'psql',
    args: [
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `select
        (select count(*) from pg_catalog.pg_namespace
          where nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'public')
            and nspname !~ '^pg_temp_' and nspname !~ '^pg_toast_temp_')
        + (select count(*) from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_type t
          join pg_catalog.pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_collation c
          join pg_catalog.pg_namespace n on n.oid = c.collnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_conversion c
          join pg_catalog.pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_operator o
          join pg_catalog.pg_namespace n on n.oid = o.oprnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_opclass o
          join pg_catalog.pg_namespace n on n.oid = o.opcnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_opfamily o
          join pg_catalog.pg_namespace n on n.oid = o.opfnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_ts_config c
          join pg_catalog.pg_namespace n on n.oid = c.cfgnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_ts_dict d
          join pg_catalog.pg_namespace n on n.oid = d.dictnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_ts_parser p
          join pg_catalog.pg_namespace n on n.oid = p.prsnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_ts_template t
          join pg_catalog.pg_namespace n on n.oid = t.tmplnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_statistic_ext s
          join pg_catalog.pg_namespace n on n.oid = s.stxnamespace
          where n.nspname = 'public')
        + (select count(*) from pg_catalog.pg_extension where extname <> 'plpgsql')
        + (select count(*) from pg_catalog.pg_largeobject_metadata)
        + (select count(*) from pg_catalog.pg_event_trigger)
        + (select count(*) from pg_catalog.pg_publication)
        + (select count(*) from pg_catalog.pg_foreign_data_wrapper)
        + (select count(*) from pg_catalog.pg_foreign_server)
        + (select count(*) from pg_catalog.pg_default_acl)`,
    ],
    environment: databaseEnvironment,
  });
  if (userObjectCount.trim() !== '0') {
    throw new Error('The restore database must be empty.');
  }

  const temporaryRoot = resolve(
    dirname(contentRoot),
    `.${basename(contentRoot)}.restore-${randomUUID()}`,
  );
  await mkdir(temporaryRoot, { mode: 0o700 });
  let contentInstalled = false;
  try {
    await options.runCommand({
      command: 'tar',
      args: ['-C', temporaryRoot, '-xf', '-'],
      environment: { PATH: options.environment.PATH ?? process.env.PATH },
      inputPath: contentPath,
    });
    await rename(temporaryRoot, contentRoot);
    contentInstalled = true;
    await options.runCommand({
      command: 'pg_restore',
      args: [
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        databaseEnvironment.PGDATABASE as string,
      ],
      environment: databaseEnvironment,
      inputPath: metadataPath,
    });
    await options.assertMetadataCurrent();
    await assertExclusiveInstallation(options.installations, installationId);
    const restored = await createVerifiedBackupManifest({
      installationId,
      createdAt: new Date(manifest.createdAt),
      references: options.references,
      content: options.content,
      inventory: options.inventory,
    });
    if (JSON.stringify(restored.referencedContent) !== JSON.stringify(manifest.referencedContent)) {
      throw new Error('Restored content does not match the backup manifest.');
    }
    return {
      apiVersion: 'v1',
      status: 'restored',
      backupId: basename(inputDirectory),
      referencedContent: manifest.referencedContent.length,
    };
  } catch (error) {
    if (!contentInstalled) await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
