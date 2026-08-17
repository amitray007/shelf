import { createHash } from 'node:crypto';

import { FOLDER_LIMITS, FOLDER_MANIFEST_VERSION, type FolderManifestInput } from '@shelf/contracts';
import type { SealedContent } from '../publishing/ports.js';
import { InvalidPublishRequestError } from '../publishing/publish.js';

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_RESERVED_CHARACTER = /[<>:"|?*]/u;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;

export interface StoredFolderDirectoryEntry {
  path: string;
  kind: 'directory';
}

export interface StoredFolderFileEntry {
  path: string;
  kind: 'file';
  mediaType: string;
  content: SealedContent;
}

export type StoredFolderEntry = StoredFolderDirectoryEntry | StoredFolderFileEntry;

function invalidPath(path: string, reason: string): InvalidPublishRequestError {
  return new InvalidPublishRequestError([{ field: `manifest.entries.${path}`, reason }]);
}

export function normalizePortableFolderPath(value: string): string {
  const path = value.normalize('NFC');
  if (path.length === 0) throw invalidPath(value, 'path must not be empty');
  if (path.startsWith('/') || path.includes('\\')) {
    throw invalidPath(value, 'path must be relative POSIX syntax');
  }
  if (/\p{Cc}/u.test(path)) throw invalidPath(value, 'path must not contain control characters');
  if (Buffer.byteLength(path, 'utf8') > FOLDER_LIMITS.maxPathBytes) {
    throw invalidPath(value, `path exceeds ${FOLDER_LIMITS.maxPathBytes} UTF-8 bytes`);
  }
  const segments = path.split('/');
  if (segments.length > FOLDER_LIMITS.maxDepth) {
    throw invalidPath(value, `path exceeds ${FOLDER_LIMITS.maxDepth} segments`);
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw invalidPath(value, 'path contains an empty, dot, or parent segment');
    }
    if (Buffer.byteLength(segment, 'utf8') > FOLDER_LIMITS.maxSegmentBytes) {
      throw invalidPath(value, `path segment exceeds ${FOLDER_LIMITS.maxSegmentBytes} UTF-8 bytes`);
    }
    if (
      WINDOWS_RESERVED_CHARACTER.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment) ||
      /[. ]$/u.test(segment)
    ) {
      throw invalidPath(value, 'path contains a cross-platform reserved segment');
    }
  }
  return path;
}

function portableAlias(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function validateRootName(rootName: string): void {
  const length = [...rootName].length;
  if (length === 0 || length > 255 || rootName.trim().length === 0 || /\p{Cc}/u.test(rootName)) {
    throw new InvalidPublishRequestError([
      { field: 'manifest.rootName', reason: 'must be a non-blank name of 1-255 characters' },
    ]);
  }
}

export function validateFolderManifestInput(manifest: FolderManifestInput): FolderManifestInput {
  if (manifest.version !== FOLDER_MANIFEST_VERSION) {
    throw new InvalidPublishRequestError([
      { field: 'manifest.version', reason: `must equal ${FOLDER_MANIFEST_VERSION}` },
    ]);
  }
  validateRootName(manifest.rootName);
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > FOLDER_LIMITS.maxManifestBytes) {
    throw new InvalidPublishRequestError([
      {
        field: 'manifest',
        reason: `must not exceed ${FOLDER_LIMITS.maxManifestBytes} UTF-8 bytes`,
      },
    ]);
  }
  if (manifest.entries.length > FOLDER_LIMITS.maxEntries) {
    throw new InvalidPublishRequestError([
      {
        field: 'manifest.entries',
        reason: `must contain at most ${FOLDER_LIMITS.maxEntries} entries`,
      },
    ]);
  }

  let fileCount = 0;
  const aliases = new Map<string, string>();
  const kinds = new Map<string, 'directory' | 'file'>();
  const entries = manifest.entries.map((entry) => {
    const path = normalizePortableFolderPath(entry.path);
    const alias = portableAlias(path);
    const existing = aliases.get(alias);
    if (existing !== undefined) {
      throw invalidPath(path, `collides with ${existing} after portable normalization`);
    }
    aliases.set(alias, path);
    kinds.set(path, entry.kind);
    if (entry.kind === 'file') {
      fileCount += 1;
      if (entry.mediaType.length > 255 || !MEDIA_TYPE_PATTERN.test(entry.mediaType)) {
        throw new InvalidPublishRequestError([
          { field: `manifest.entries.${path}.mediaType`, reason: 'must be a valid type/subtype' },
        ]);
      }
    }
    return { ...entry, path };
  });
  if (fileCount > FOLDER_LIMITS.maxFiles) {
    throw new InvalidPublishRequestError([
      { field: 'manifest.entries', reason: `must contain at most ${FOLDER_LIMITS.maxFiles} files` },
    ]);
  }
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (kinds.get(parent) !== 'directory') {
        throw invalidPath(entry.path, `parent directory ${parent} must be explicit`);
      }
    }
  }
  return { ...manifest, entries };
}

function comparePaths(left: StoredFolderEntry, right: StoredFolderEntry): number {
  return Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'));
}

export function canonicalFolderManifest(entries: readonly StoredFolderEntry[]): {
  bytes: Uint8Array;
  contentHash: string;
  byteCount: number;
  fileCount: number;
} {
  const ordered = [...entries].sort(comparePaths);
  let byteCount = 0;
  let fileCount = 0;
  const canonicalEntries = ordered.map((entry) => {
    if (entry.kind === 'directory') return { path: entry.path, kind: entry.kind };
    byteCount += entry.content.byteCount;
    fileCount += 1;
    return {
      path: entry.path,
      kind: entry.kind,
      mediaType: entry.mediaType,
      contentHash: entry.content.contentHash,
      byteCount: entry.content.byteCount,
    };
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: FOLDER_MANIFEST_VERSION, entries: canonicalEntries }),
  );
  return {
    bytes,
    contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byteCount,
    fileCount,
  };
}
