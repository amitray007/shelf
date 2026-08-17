import {
  COMPARISON_LIMITS,
  type FileRevisionComparison,
  FOLDER_LIMITS,
  type FolderComparisonItem,
  type FolderEntry,
  type FolderRevisionComparison,
  READ_REVISION_OPERATION,
  type RevisionComparison,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { StoredFolderEntry } from '../folders/snapshot.js';
import type { Authorizer, SealedContent } from '../publishing/ports.js';
import { RevisionNotFoundError } from './read.js';

export interface ComparableFileRevision {
  kind: 'file';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  content: SealedContent;
  originalFileName: string;
  mediaType: string;
}

export interface ComparableFolderRevision {
  kind: 'folder';
  installationId: string;
  workspaceId: string;
  artifactId: string;
  revisionId: string;
  manifest: SealedContent;
  rootName: string;
  totalByteCount: number;
  fileCount: number;
}

export type ComparableRevision = ComparableFileRevision | ComparableFolderRevision;

export interface RevisionComparisonRepository {
  findComparableRevision(revisionId: string): Promise<ComparableRevision | undefined>;
  listFolderEntries(request: {
    installationId: string;
    revisionId: string;
    limit: number;
    afterPath?: string;
  }): Promise<{ items: StoredFolderEntry[]; nextPath?: string }>;
}

export class InvalidRevisionComparisonRequestError extends ShelfCoreError {
  constructor(field: 'cursor' | 'limit' | 'targetRevisionId') {
    super('INVALID_REQUEST', 'The revision comparison request is invalid.', {
      retryable: false,
      details: [{ field, reason: `must be a valid ${field}` }],
    });
    this.name = 'InvalidRevisionComparisonRequestError';
  }
}

function fileDescriptor(revision: ComparableFileRevision) {
  return {
    revisionId: revision.revisionId,
    contentHash: revision.content.contentHash,
    byteCount: revision.content.byteCount,
    originalFileName: revision.originalFileName,
    mediaType: revision.mediaType,
  };
}

function compareFiles(
  base: ComparableFileRevision,
  target: ComparableFileRevision,
): FileRevisionComparison {
  const changes = {
    content:
      base.content.contentHash !== target.content.contentHash ||
      base.content.byteCount !== target.content.byteCount,
    mediaType: base.mediaType !== target.mediaType,
    originalFileName: base.originalFileName !== target.originalFileName,
  };
  return {
    apiVersion: 'v1',
    kind: 'file',
    workspaceId: base.workspaceId,
    artifactId: base.artifactId,
    base: fileDescriptor(base),
    target: fileDescriptor(target),
    status: Object.values(changes).some(Boolean) ? 'changed' : 'unchanged',
    changes,
  };
}

function publicEntry(value: StoredFolderEntry): FolderEntry {
  return value.kind === 'directory'
    ? { path: value.path, kind: 'directory' }
    : {
        path: value.path,
        kind: 'file',
        mediaType: value.mediaType,
        contentHash: value.content.contentHash,
        byteCount: value.content.byteCount,
      };
}

function entriesEqual(base: StoredFolderEntry, target: StoredFolderEntry): boolean {
  if (base.kind !== target.kind) return false;
  if (base.kind === 'directory' && target.kind === 'directory') return true;
  if (base.kind === 'file' && target.kind === 'file') {
    return (
      base.mediaType === target.mediaType &&
      base.content.contentHash === target.content.contentHash &&
      base.content.byteCount === target.content.byteCount
    );
  }
  return false;
}

function byteIdentity(entry: StoredFolderEntry): string | undefined {
  return entry.kind === 'file'
    ? `${entry.content.contentHash}\u0000${entry.content.byteCount}`
    : undefined;
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function itemPath(item: FolderComparisonItem): string {
  return item.status === 'moved' ? item.toPath : item.path;
}

function compareItems(left: FolderComparisonItem, right: FolderComparisonItem): number {
  const path = comparePaths(itemPath(left), itemPath(right));
  return path === 0 ? left.status.localeCompare(right.status) : path;
}

async function allFolderEntries(
  repository: RevisionComparisonRepository,
  request: { installationId: string; revisionId: string },
): Promise<StoredFolderEntry[]> {
  const entries: StoredFolderEntry[] = [];
  let afterPath: string | undefined;
  while (true) {
    const page = await repository.listFolderEntries({
      ...request,
      limit: COMPARISON_LIMITS.pageSize,
      ...(afterPath === undefined ? {} : { afterPath }),
    });
    entries.push(...page.items);
    if (entries.length > FOLDER_LIMITS.maxEntries) {
      throw new Error('Folder comparison repository exceeded the accepted entry limit.');
    }
    if (page.nextPath === undefined) break;
    if (page.items.length === 0 || page.nextPath === afterPath) {
      throw new Error('Folder comparison repository returned a non-progressing page.');
    }
    afterPath = page.nextPath;
  }
  return entries.sort((left, right) => comparePaths(left.path, right.path));
}

function folderDescriptor(revision: ComparableFolderRevision) {
  return {
    revisionId: revision.revisionId,
    contentHash: revision.manifest.contentHash,
    byteCount: revision.totalByteCount,
    fileCount: revision.fileCount,
    rootName: revision.rootName,
  };
}

function encodeCursor(value: {
  baseRevisionId: string;
  targetRevisionId: string;
  offset: number;
}): string {
  return Buffer.from(
    JSON.stringify({ v: 1, kind: 'revision-comparison', ...value }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(
  value: string | undefined,
  baseRevisionId: string,
  targetRevisionId: string,
): number {
  if (value === undefined) return 0;
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw new Error('invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      parsed.v !== 1 ||
      parsed.kind !== 'revision-comparison' ||
      parsed.baseRevisionId !== baseRevisionId ||
      parsed.targetRevisionId !== targetRevisionId ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error('invalid cursor');
    }
    return parsed.offset as number;
  } catch {
    throw new InvalidRevisionComparisonRequestError('cursor');
  }
}

async function compareFolders(
  repository: RevisionComparisonRepository,
  base: ComparableFolderRevision,
  target: ComparableFolderRevision,
  request: { limit: number; cursor?: string },
): Promise<FolderRevisionComparison> {
  const offset = decodeCursor(request.cursor, base.revisionId, target.revisionId);
  let baseEntries: StoredFolderEntry[];
  let targetEntries: StoredFolderEntry[];
  try {
    [baseEntries, targetEntries] = await Promise.all([
      allFolderEntries(repository, {
        installationId: base.installationId,
        revisionId: base.revisionId,
      }),
      allFolderEntries(repository, {
        installationId: target.installationId,
        revisionId: target.revisionId,
      }),
    ]);
  } catch (error) {
    throw boundaryFailure('SERVICE_UNAVAILABLE', 'Folder comparison lookup failed.', error);
  }
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry]));
  const targetByPath = new Map(targetEntries.map((entry) => [entry.path, entry]));
  const changed: FolderComparisonItem[] = [];
  const removed: StoredFolderEntry[] = [];
  const added: StoredFolderEntry[] = [];
  let unchanged = 0;

  for (const entry of baseEntries) {
    const counterpart = targetByPath.get(entry.path);
    if (counterpart === undefined) {
      removed.push(entry);
    } else if (entriesEqual(entry, counterpart)) {
      unchanged += 1;
    } else {
      changed.push({
        status: 'changed',
        path: entry.path,
        before: publicEntry(entry),
        after: publicEntry(counterpart),
      });
    }
  }
  for (const entry of targetEntries) {
    if (!baseByPath.has(entry.path)) added.push(entry);
  }

  const removedByIdentity = new Map<string, StoredFolderEntry[]>();
  const addedByIdentity = new Map<string, StoredFolderEntry[]>();
  for (const entry of removed) {
    const identity = byteIdentity(entry);
    if (identity !== undefined)
      removedByIdentity.set(identity, [...(removedByIdentity.get(identity) ?? []), entry]);
  }
  for (const entry of added) {
    const identity = byteIdentity(entry);
    if (identity !== undefined)
      addedByIdentity.set(identity, [...(addedByIdentity.get(identity) ?? []), entry]);
  }
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  const moved: FolderComparisonItem[] = [];
  for (const [identity, beforeMatches] of removedByIdentity) {
    const afterMatches = addedByIdentity.get(identity);
    const before = beforeMatches[0];
    const after = afterMatches?.[0];
    if (
      beforeMatches.length !== 1 ||
      afterMatches?.length !== 1 ||
      before === undefined ||
      after === undefined
    ) {
      continue;
    }
    movedFrom.add(before.path);
    movedTo.add(after.path);
    moved.push({
      status: 'moved',
      fromPath: before.path,
      toPath: after.path,
      before: publicEntry(before),
      after: publicEntry(after),
    });
  }
  const removedItems: FolderComparisonItem[] = removed
    .filter((entry) => !movedFrom.has(entry.path))
    .map((before) => ({ status: 'removed', path: before.path, before: publicEntry(before) }));
  const addedItems: FolderComparisonItem[] = added
    .filter((entry) => !movedTo.has(entry.path))
    .map((after) => ({ status: 'added', path: after.path, after: publicEntry(after) }));
  const items = [...addedItems, ...removedItems, ...changed, ...moved].sort(compareItems);
  const page = items.slice(offset, offset + request.limit);
  const nextOffset = offset + page.length;

  return {
    apiVersion: 'v1',
    kind: 'folder',
    workspaceId: base.workspaceId,
    artifactId: base.artifactId,
    base: folderDescriptor(base),
    target: folderDescriptor(target),
    summary: {
      added: addedItems.length,
      removed: removedItems.length,
      moved: moved.length,
      changed: changed.length,
      unchanged,
    },
    items: page,
    nextCursor:
      nextOffset < items.length
        ? encodeCursor({
            baseRevisionId: base.revisionId,
            targetRevisionId: target.revisionId,
            offset: nextOffset,
          })
        : null,
  };
}

export function createRevisionComparisonService(dependencies: {
  authorizer: Authorizer;
  revisions: RevisionComparisonRepository;
}) {
  return async function compareRevisions(request: {
    installationId: string;
    actorId: string;
    baseRevisionId: string;
    targetRevisionId: string;
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<RevisionComparison> {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > COMPARISON_LIMITS.pageSize
    ) {
      throw new InvalidRevisionComparisonRequestError('limit');
    }
    let base: ComparableRevision | undefined;
    let target: ComparableRevision | undefined;
    try {
      request.signal?.throwIfAborted();
      [base, target] = await Promise.all([
        dependencies.revisions.findComparableRevision(request.baseRevisionId),
        dependencies.revisions.findComparableRevision(request.targetRevisionId),
      ]);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision comparison lookup failed.', error);
    }
    if (
      base === undefined ||
      target === undefined ||
      base.installationId !== request.installationId ||
      target.installationId !== request.installationId ||
      base.revisionId !== request.baseRevisionId ||
      target.revisionId !== request.targetRevisionId
    ) {
      throw new RevisionNotFoundError();
    }
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: base.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    if (target.workspaceId !== base.workspaceId) {
      await dependencies.authorizer.authorize(
        {
          installationId: request.installationId,
          workspaceId: target.workspaceId,
          actorId: request.actorId,
          action: READ_REVISION_OPERATION,
        },
        request.signal,
      );
    }
    if (
      base.workspaceId !== target.workspaceId ||
      base.artifactId !== target.artifactId ||
      base.kind !== target.kind
    ) {
      throw new InvalidRevisionComparisonRequestError('targetRevisionId');
    }
    if (base.kind === 'file' && target.kind === 'file') {
      if (request.cursor !== undefined) {
        throw new InvalidRevisionComparisonRequestError('cursor');
      }
      return compareFiles(base, target);
    }
    if (base.kind === 'folder' && target.kind === 'folder') {
      return compareFolders(dependencies.revisions, base, target, request);
    }
    throw new InvalidRevisionComparisonRequestError('targetRevisionId');
  };
}
