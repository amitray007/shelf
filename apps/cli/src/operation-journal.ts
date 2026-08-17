import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type FolderPublishResult,
  isFolderPublishResult,
  isPublishResult,
  type PublishResult,
} from '@shelf/contracts';

import { failure, usageFailure } from './output.js';
import { ensurePrivateDirectory, writePrivateFileAtomically } from './secure-state.js';

const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 1_024;
const LOCK_ATTEMPTS = 80;
const LOCK_RETRY_MS = 25;

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

export type JournalPublishResult = PublishResult | FolderPublishResult;

interface PublishOperationRecord {
  readonly version: 1;
  readonly fingerprint: string;
  readonly publishIdempotencyKey: string;
  readonly shareIdempotencyKey: string;
  readonly publish: JournalPublishResult | null;
}

export interface PublishOperationJournal {
  readonly record: PublishOperationRecord;
  savePublish(publish: JournalPublishResult): Promise<void>;
  complete(): Promise<void>;
}

function dataDirectory(env: Readonly<Record<string, string | undefined>>): string {
  if (env.SHELF_DATA_DIR !== undefined && env.SHELF_DATA_DIR.length > 0) return env.SHELF_DATA_DIR;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Shelf');
  }
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Shelf', 'Data');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'shelf');
}

function isRecord(value: unknown): value is PublishOperationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    record.version === 1 &&
    typeof record.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/u.test(record.fingerprint) &&
    typeof record.publishIdempotencyKey === 'string' &&
    record.publishIdempotencyKey.length > 0 &&
    typeof record.shareIdempotencyKey === 'string' &&
    record.shareIdempotencyKey.length > 0 &&
    (record.publish === null ||
      isPublishResult(record.publish) ||
      isFolderPublishResult(record.publish))
  );
}

async function readRecord(path: string): Promise<PublishOperationRecord | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JOURNAL_BYTES) {
      throw usageFailure('The Shelf operation state is unsafe or invalid.');
    }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value)) throw usageFailure('The Shelf operation state is invalid.');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw usageFailure('The Shelf operation state is invalid.');
    throw error;
  }
}

async function writeRecord(path: string, record: PublishOperationRecord): Promise<void> {
  await writePrivateFileAtomically(
    path,
    `${JSON.stringify(record)}\n`,
    'The Shelf operation state is unsafe or invalid.',
  );
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as Record<string, unknown>;
  return (
    Object.keys(owner).length === 3 &&
    owner.version === 1 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.token === 'string' &&
    /^[A-Za-z0-9-]{36}$/u.test(owner.token)
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function lockOwner(path: string): Promise<LockOwner | null> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw usageFailure('The Shelf operation lock is unsafe or invalid.');
  }
  if (metadata.size === 0 || metadata.size > MAX_LOCK_BYTES) return null;
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLockOwner(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function reclaimDeadLock(path: string): Promise<boolean> {
  const owner = await lockOwner(path);
  if (owner === null || processIsAlive(owner.pid)) return false;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

async function releaseLock(path: string, owner: LockOwner): Promise<void> {
  const persisted = await lockOwner(path);
  if (persisted?.token !== owner.token) return;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function withRecordLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>>;
    const owner: LockOwner = { version: 1, pid: process.pid, token: randomUUID() };
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimDeadLock(lockPath)) continue;
      if (attempt === LOCK_ATTEMPTS) {
        throw failure('SERVICE_UNAVAILABLE', 'Another Shelf publish is updating this operation.', {
          retryable: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }

    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      return await operation();
    } finally {
      await handle.close();
      await releaseLock(lockPath, owner);
    }
  }
  throw failure('SERVICE_UNAVAILABLE', 'Shelf could not acquire the local operation lock.', {
    retryable: true,
  });
}

export function publishOperationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function openPublishOperation(
  env: Readonly<Record<string, string | undefined>>,
  fingerprint: string,
): Promise<PublishOperationJournal> {
  const directory = join(dataDirectory(env), 'operations');
  await ensurePrivateDirectory(
    directory,
    'The Shelf operation-state directory must be a real directory.',
  );
  const path = join(directory, `${fingerprint}.json`);
  const existing = await withRecordLock(path, async () => {
    const persisted = await readRecord(path);
    if (persisted !== null) return persisted;
    const created: PublishOperationRecord = {
      version: 1,
      fingerprint,
      publishIdempotencyKey: `publish-${randomUUID()}`,
      shareIdempotencyKey: `share-${randomUUID()}`,
      publish: null,
    };
    await writeRecord(path, created);
    return created;
  });
  let current: PublishOperationRecord;
  current = existing;
  if (current.fingerprint !== fingerprint) {
    throw usageFailure('The Shelf operation state does not match this publish request.');
  }

  return {
    get record() {
      return current;
    },
    async savePublish(publish) {
      await withRecordLock(path, async () => {
        const persisted = await readRecord(path);
        if (persisted?.publish !== null && persisted?.publish !== undefined) {
          current = persisted;
          return;
        }
        current = { ...(persisted ?? current), publish };
        await writeRecord(path, current);
      });
    },
    async complete() {
      await withRecordLock(path, async () => {
        const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (metadata === null) return;
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          throw usageFailure('The Shelf operation state is unsafe or invalid.');
        }
        await unlink(path);
      });
    },
  };
}
