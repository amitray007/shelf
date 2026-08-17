import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { usageFailure } from './output.js';

export async function ensurePrivateDirectory(path: string, unsafeMessage: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw usageFailure(unsafeMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) throw usageFailure(unsafeMessage);
  }
  await chmod(path, 0o700);
}

export async function writePrivateFileAtomically(
  path: string,
  contents: string,
  unsafeMessage: string,
): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) throw usageFailure(unsafeMessage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await chmod(path, 0o600);
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}
