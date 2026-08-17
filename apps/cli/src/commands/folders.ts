import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

import {
  FOLDER_LIMITS,
  FOLDER_MANIFEST_VERSION,
  type FolderManifestInput,
  type FolderPublishResult,
  type FolderTreePage,
} from '@shelf/contracts';

import { getFolderTree, publishFolder, type ShelfClientDependencies } from '../client.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';
import { publisherMetadata } from './publish.js';

export interface PublishFolderCommandOptions {
  url: string;
  workspace: string;
  directory: string;
  idempotencyKey: string;
  artifact?: string;
  metadata: readonly string[];
  allowInsecureLoopback?: boolean;
}

export interface FolderTreeCommandOptions {
  url: string;
  revision: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
}

interface LocalFolderFile {
  absolutePath: string;
  path: string;
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/u;

function token(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

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

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css';
    case '.csv':
      return 'text/csv';
    case '.gif':
      return 'image/gif';
    case '.htm':
    case '.html':
      return 'text/html';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.js':
    case '.mjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.txt':
      return 'text/plain';
    case '.wasm':
      return 'application/wasm';
    case '.webp':
      return 'image/webp';
    case '.xml':
      return 'application/xml';
    case '.yaml':
    case '.yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
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

function comparePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function localFolder(directory: string): Promise<{
  manifest: FolderManifestInput;
  files: LocalFolderFile[];
}> {
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
        entries.push({ path, kind: 'file', mediaType: mediaType(path) });
        files.push({ path, absolutePath });
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
  return {
    manifest,
    files,
  };
}

export async function executePublishFolder(
  options: PublishFolderCommandOptions,
  runtime: CliRuntime,
  dependencies?: Partial<ShelfClientDependencies>,
): Promise<FolderPublishResult> {
  const folder = await localFolder(options.directory);
  return publishFolder(
    {
      installationUrl: options.url,
      workspaceId: options.workspace,
      directoryPath: options.directory,
      idempotencyKey: options.idempotencyKey,
      ...(options.artifact === undefined
        ? {}
        : { artifactId: opaqueId(options.artifact, 'artifact') }),
      token: token(runtime),
      publisherMetadata: publisherMetadata(options.metadata),
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
          return openAsBlob(path);
        }),
    },
  );
}

export function executeFolderTree(
  options: FolderTreeCommandOptions,
  runtime: CliRuntime,
): Promise<FolderTreePage> {
  return getFolderTree(
    {
      installationUrl: options.url,
      revisionId: opaqueId(options.revision, 'revision'),
      limit: positiveLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
