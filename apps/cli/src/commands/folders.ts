import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import {
  FOLDER_LIMITS,
  FOLDER_MANIFEST_VERSION,
  type FolderManifestInput,
  type FolderPublishResult,
  type FolderTreePage,
} from '@shelf/contracts';

import {
  downloadFolderEntryContent,
  getFolderTree,
  publishFolder,
  type ShelfClientDependencies,
} from '../client.js';
import { resolveRemoteContext, resolveWorkspaceContext, transportFields } from '../context.js';
import { downloadToPath } from '../download.js';
import { mediaTypeForPath } from '../media-type.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';
import { publisherMetadata, requireAgentMetadata } from './publish.js';

export interface PublishFolderCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  directory: string;
  idempotencyKey: string;
  artifact?: string;
  metadata: readonly string[];
  title?: string;
  description?: string;
  userBypass?: boolean;
  allowInsecureLoopback?: boolean;
}

export interface FolderTreeCommandOptions {
  profile?: string;
  url?: string;
  revision: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
}

export interface FolderDownloadCommandOptions {
  profile?: string;
  url?: string;
  revision: string;
  path: string;
  output: string;
  overwrite?: boolean;
  allowInsecureLoopback?: boolean;
}

export interface FolderDownloadResult {
  apiVersion: 'v1';
  operation: 'folders.download';
  revisionId: string;
  path: string;
  output: string;
  byteCount: number;
  mediaType: string;
  entityTag: string | null;
}

interface LocalFolderFile {
  absolutePath: string;
  path: string;
  byteCount: number;
  modifiedAtMs: number;
}

export interface PreparedLocalFolder {
  readonly manifest: FolderManifestInput;
  readonly files: readonly LocalFolderFile[];
  readonly contentFingerprint: string;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/u;

function opaqueId(value: string, kind: 'artifact' | 'revision'): string {
  const prefix = kind === 'artifact' ? 'art' : 'rev';
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`, 'u').test(value)) {
    throw usageFailure(`The ${kind} ID is invalid.`);
  }
  return value;
}

function positiveLimit(value: string | undefined): number {
  if (value === undefined) return FOLDER_LIMITS.treePageSize;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > FOLDER_LIMITS.treePageSize) {
    throw usageFailure(`The limit must be an integer from 1 to ${FOLDER_LIMITS.treePageSize}.`);
  }
  return parsed;
}

function portablePath(path: string): string {
  const normalized = path.normalize('NFC');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    /\p{Cc}/u.test(normalized) ||
    Buffer.byteLength(normalized, 'utf8') > FOLDER_LIMITS.maxPathBytes ||
    segments.length > FOLDER_LIMITS.maxDepth ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf8') > FOLDER_LIMITS.maxSegmentBytes ||
        WINDOWS_RESERVED_CHARACTER.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment) ||
        /[. ]$/u.test(segment),
    )
  ) {
    throw usageFailure(`The directory contains a non-portable path: ${path}`);
  }
  return normalized;
}

/**
 * Validates one folder entry path for retrieval against the same rules the API applies in
 * PortableFolderPathSchema. Publish-time portability rules are deliberately not applied here so
 * that any entry the API accepted can still be downloaded.
 */
function entryPath(path: string): string {
  const normalized = path.normalize('NFC');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > FOLDER_LIMITS.maxPathBytes ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    /\p{Cc}/u.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw usageFailure('The folder entry path is invalid.');
  }
  return normalized;
}

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export async function prepareLocalFolder(directory: string): Promise<PreparedLocalFolder> {
  let root: Stats;
  try {
    root = await lstat(directory);
  } catch {
    throw usageFailure('The directory cannot be read.');
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw usageFailure('The directory path must identify a real directory, not a link.');
  }
  const entries: FolderManifestInput['entries'] = [];
  const files: LocalFolderFile[] = [];
  const aliases = new Map<string, string>();
  let totalBytes = 0;

  async function walk(parent: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      throw usageFailure('The directory tree cannot be read.');
    }
    names.sort(comparePath);
    for (const name of names) {
      const absolutePath = join(parent, name);
      let stat: Stats;
      try {
        stat = await lstat(absolutePath);
      } catch {
        throw usageFailure('The directory tree changed while it was being inspected.');
      }
      const localRelative = relative(directory, absolutePath);
      const path = portablePath(sep === '/' ? localRelative : localRelative.split(sep).join('/'));
      const alias = path.toLocaleLowerCase('en-US');
      const collision = aliases.get(alias);
      if (collision !== undefined) {
        throw usageFailure(
          `The directory contains colliding portable paths: ${collision}, ${path}`,
        );
      }
      aliases.set(alias, path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw usageFailure(`The directory contains a symlink or special file: ${path}`);
      }
      if (stat.isDirectory()) {
        entries.push({ path, kind: 'directory' });
        await walk(absolutePath);
      } else {
        if (stat.size > FOLDER_LIMITS.maxFileBytes) {
          throw usageFailure(
            `A file exceeds the ${FOLDER_LIMITS.maxFileBytes}-byte limit: ${path}`,
          );
        }
        totalBytes += stat.size;
        if (totalBytes > FOLDER_LIMITS.maxTotalBytes) {
          throw usageFailure(`The folder exceeds the ${FOLDER_LIMITS.maxTotalBytes}-byte limit.`);
        }
        entries.push({ path, kind: 'file', mediaType: mediaTypeForPath(path) });
        files.push({ path, absolutePath, byteCount: stat.size, modifiedAtMs: stat.mtimeMs });
      }
      if (entries.length > FOLDER_LIMITS.maxEntries || files.length > FOLDER_LIMITS.maxFiles) {
        throw usageFailure('The directory exceeds the supported folder entry limits.');
      }
    }
  }

  await walk(directory);
  entries.sort((left, right) => comparePath(left.path, right.path));
  files.sort((left, right) => comparePath(left.path, right.path));
  const rootName = basename(directory);
  if (rootName.trim().length === 0 || [...rootName].length > 255 || /\p{Cc}/u.test(rootName)) {
    throw usageFailure('The directory root name is invalid.');
  }
  const manifest: FolderManifestInput = {
    version: FOLDER_MANIFEST_VERSION,
    rootName,
    entries,
  };
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > FOLDER_LIMITS.maxManifestBytes) {
    throw usageFailure(
      `The folder manifest exceeds the ${FOLDER_LIMITS.maxManifestBytes}-byte limit.`,
    );
  }
  const fingerprint = createHash('sha256');
  const manifestJson = JSON.stringify(manifest);
  fingerprint.update(`${Buffer.byteLength(manifestJson, 'utf8')}:`);
  fingerprint.update(manifestJson);
  for (const file of files) {
    fingerprint.update(`\n${Buffer.byteLength(file.path, 'utf8')}:${file.path}:${file.byteCount}:`);
    try {
      for await (const chunk of createReadStream(file.absolutePath)) fingerprint.update(chunk);
      const current = await lstat(file.absolutePath);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.size !== file.byteCount ||
        current.mtimeMs !== file.modifiedAtMs
      ) {
        throw new Error('changed');
      }
    } catch {
      throw usageFailure('The directory tree changed while it was being inspected.');
    }
  }
  return { manifest, files, contentFingerprint: fingerprint.digest('hex') };
}

export async function executePublishFolder(
  options: PublishFolderCommandOptions,
  runtime: CliRuntime,
  dependencies?: Partial<ShelfClientDependencies>,
): Promise<FolderPublishResult> {
  const context = await resolveWorkspaceContext(options, runtime);
  return executePublishFolderWithToken(
    {
      ...options,
      url: context.installationUrl,
      workspace: context.workspaceId,
      ...(context.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: context.allowInsecureLoopback }),
    },
    runtime,
    context.token,
    dependencies,
  );
}

export async function executePublishFolderWithToken(
  options: PublishFolderCommandOptions & { url: string; workspace: string },
  runtime: CliRuntime,
  authenticationToken: string,
  dependencies?: Partial<ShelfClientDependencies>,
  prepared?: PreparedLocalFolder,
): Promise<FolderPublishResult> {
  const metadata = publisherMetadata(options);
  requireAgentMetadata(metadata, options.userBypass);
  const folder = prepared ?? (await prepareLocalFolder(options.directory));
  return publishFolder(
    {
      installationUrl: options.url,
      workspaceId: options.workspace,
      directoryPath: options.directory,
      idempotencyKey: options.idempotencyKey,
      ...(options.artifact === undefined
        ? {}
        : { artifactId: opaqueId(options.artifact, 'artifact') }),
      token: authenticationToken,
      publisherMetadata: metadata,
      manifest: folder.manifest,
      files: folder.files,
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    {
      fetch: dependencies?.fetch ?? runtime.fetch ?? globalThis.fetch,
      openFileBlob:
        dependencies?.openFileBlob ??
        (async (path) => {
          const { openAsBlob } = await import('node:fs');
          return openAsBlob(path, { type: mediaTypeForPath(path) });
        }),
    },
  );
}

export async function executeFolderTree(
  options: FolderTreeCommandOptions,
  runtime: CliRuntime,
): Promise<FolderTreePage> {
  const context = await resolveRemoteContext(options, runtime);
  return getFolderTree(
    {
      ...transportFields(context),
      revisionId: opaqueId(options.revision, 'revision'),
      limit: positiveLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeFolderDownload(
  options: FolderDownloadCommandOptions,
  runtime: CliRuntime,
): Promise<FolderDownloadResult> {
  const revision = opaqueId(options.revision, 'revision');
  const path = entryPath(options.path);
  const context = await resolveRemoteContext(options, runtime);
  const downloaded = await downloadToPath(
    {
      outputPath: options.output,
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
      failureMessage: 'The folder entry download could not be written safely.',
    },
    () =>
      downloadFolderEntryContent(
        { ...transportFields(context), revisionId: revision, path },
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      ),
  );
  return {
    apiVersion: 'v1',
    operation: 'folders.download',
    revisionId: revision,
    path,
    output: downloaded.output,
    byteCount: downloaded.byteCount,
    mediaType: downloaded.mediaType,
    entityTag: downloaded.entityTag,
  };
}
