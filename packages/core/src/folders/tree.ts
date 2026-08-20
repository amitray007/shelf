import {
  FOLDER_LIMITS,
  type FolderEntry,
  type FolderTreePage,
  READ_REVISION_OPERATION,
} from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type { Authorizer, ContentReader } from '../publishing/ports.js';
import { RevisionNotFoundError } from '../revisions/read.js';
import type { FolderRevisionRepository, StoredFolderRevision } from './publish.js';
import type { StoredFolderEntry } from './snapshot.js';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

export class InvalidFolderTreeRequestError extends ShelfCoreError {
  constructor(field: 'cursor' | 'limit') {
    super('INVALID_REQUEST', 'The folder tree request is invalid.', {
      retryable: false,
      details: [{ field, reason: `must be a valid ${field}` }],
    });
    this.name = 'InvalidFolderTreeRequestError';
  }
}

function decodeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (!CURSOR_PATTERN.test(value)) throw new Error('invalid cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).v !== 1 ||
      typeof (parsed as Record<string, unknown>).path !== 'string'
    ) {
      throw new Error('invalid cursor');
    }
    return (parsed as { path: string }).path;
  } catch {
    throw new InvalidFolderTreeRequestError('cursor');
  }
}

function encodeCursor(path: string): string {
  return Buffer.from(JSON.stringify({ v: 1, path }), 'utf8').toString('base64url');
}

function entry(value: StoredFolderEntry): FolderEntry {
  if (value.kind === 'directory') return { path: value.path, kind: 'directory' };
  return {
    path: value.path,
    kind: 'file',
    mediaType: value.mediaType,
    contentHash: value.content.contentHash,
    byteCount: value.content.byteCount,
  };
}

export function createFolderTreeService(dependencies: {
  authorizer: Authorizer;
  folders: FolderRevisionRepository;
}) {
  return async function getFolderTree(request: {
    installationId: string;
    actorId: string;
    revisionId: string;
    limit: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<FolderTreePage> {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > FOLDER_LIMITS.treePageSize
    ) {
      throw new InvalidFolderTreeRequestError('limit');
    }
    const afterPath = decodeCursor(request.cursor);
    let revision: StoredFolderRevision | undefined;
    try {
      request.signal?.throwIfAborted();
      revision = await dependencies.folders.findFolderRevision(request.revisionId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Folder revision lookup failed.', error);
    }
    if (
      revision === undefined ||
      revision.revisionId !== request.revisionId ||
      revision.installationId !== request.installationId
    ) {
      throw new RevisionNotFoundError();
    }
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: revision.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    let page: { items: StoredFolderEntry[]; nextPath?: string };
    try {
      page = await dependencies.folders.listFolderEntries({
        installationId: request.installationId,
        revisionId: request.revisionId,
        limit: request.limit,
        ...(afterPath === undefined ? {} : { afterPath }),
      });
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Folder tree lookup failed.', error);
    }
    return {
      apiVersion: 'v1',
      revisionId: revision.revisionId,
      contentHash: revision.manifest.contentHash,
      byteCount: revision.totalByteCount,
      fileCount: revision.fileCount,
      items: page.items.map(entry),
      nextCursor: page.nextPath === undefined ? null : encodeCursor(page.nextPath),
    };
  };
}

export function createFolderEntryContentService(dependencies: {
  authorizer: Authorizer;
  contentReader: ContentReader;
  folders: FolderRevisionRepository;
}) {
  return async function readFolderEntry(request: {
    installationId: string;
    actorId: string;
    revisionId: string;
    path: string;
    signal?: AbortSignal;
  }) {
    const revision = await dependencies.folders.findFolderRevision(request.revisionId);
    if (
      revision === undefined ||
      revision.installationId !== request.installationId ||
      revision.revisionId !== request.revisionId
    ) {
      throw new RevisionNotFoundError();
    }
    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: revision.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    const page = await dependencies.folders.listFolderEntries({
      installationId: request.installationId,
      revisionId: request.revisionId,
      limit: FOLDER_LIMITS.maxEntries,
    });
    const entry = page.items.find((candidate) => candidate.path === request.path);
    if (entry === undefined || entry.kind !== 'file') throw new RevisionNotFoundError();
    return {
      path: entry.path,
      mediaType: entry.mediaType,
      byteCount: entry.content.byteCount,
      contentHash: entry.content.contentHash,
      read: () =>
        dependencies.contentReader.read(entry.content, {
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
    };
  };
}
