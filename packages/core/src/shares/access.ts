import { FOLDER_LIMITS, type FolderEntry, type FolderTreePage } from '@shelf/contracts';

import { boundaryFailure } from '../errors.js';
import type { FolderRevisionRepository, StoredFolderRevision } from '../folders/publish.js';
import { InvalidFolderTreeRequestError } from '../folders/tree.js';
import type {
  ContentReader,
  RevisionRepository,
  SealedContent,
  StoredRevision,
} from '../publishing/ports.js';
import { ShareNotFoundError } from './lifecycle.js';
import type { ShareCapabilityCodec, ShareClock, ShareRepository } from './ports.js';
import { createShareResolutionService } from './resolution.js';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;

export interface PublicSharedFile {
  revisionId: string;
  originalFileName: string;
  byteCount: number;
  read(): Promise<AsyncIterable<Uint8Array>>;
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

function publicEntry(
  value: Awaited<ReturnType<FolderRevisionRepository['listFolderEntries']>>['items'][number],
): FolderEntry {
  if (value.kind === 'directory') return { path: value.path, kind: 'directory' };
  return {
    path: value.path,
    kind: 'file',
    mediaType: value.mediaType,
    contentHash: value.content.contentHash,
    byteCount: value.content.byteCount,
  };
}

function validFileScope(
  stored: StoredRevision | undefined,
  expected: {
    artifactId: string;
    revisionId: string;
    originalFileName: string;
    mediaType: string;
    byteCount: number;
  },
): stored is StoredRevision {
  return (
    stored !== undefined &&
    stored.artifactId === expected.artifactId &&
    stored.revisionId === expected.revisionId &&
    stored.originalFileName === expected.originalFileName &&
    stored.mediaType === expected.mediaType &&
    stored.content.byteCount === expected.byteCount
  );
}

function validFolderScope(
  stored: StoredFolderRevision | undefined,
  expected: {
    artifactId: string;
    revisionId: string;
    rootName: string;
    byteCount: number;
    fileCount: number;
  },
): stored is StoredFolderRevision {
  return (
    stored !== undefined &&
    stored.artifactId === expected.artifactId &&
    stored.revisionId === expected.revisionId &&
    stored.rootName === expected.rootName &&
    stored.totalByteCount === expected.byteCount &&
    stored.fileCount === expected.fileCount
  );
}

export function createShareAccessService(dependencies: {
  shares: ShareRepository;
  capabilityCodec: ShareCapabilityCodec;
  revisions: RevisionRepository;
  folders: FolderRevisionRepository;
  contentReader: ContentReader;
  clock?: ShareClock;
}) {
  const resolveShare = createShareResolutionService({
    shares: dependencies.shares,
    capabilityCodec: dependencies.capabilityCodec,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });

  return {
    async readFile(request: {
      shareId: string;
      secret: string;
      signal?: AbortSignal;
    }): Promise<PublicSharedFile> {
      const resolved = await resolveShare(request);
      if (resolved.artifact.kind !== 'file' || resolved.revision.kind !== 'file') {
        throw new ShareNotFoundError();
      }
      let stored: StoredRevision | undefined;
      try {
        request.signal?.throwIfAborted();
        stored = await dependencies.revisions.findRevision(resolved.revision.revisionId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Shared content lookup failed.', error);
      }
      if (
        !validFileScope(stored, {
          artifactId: resolved.artifact.artifactId,
          revisionId: resolved.revision.revisionId,
          originalFileName: resolved.revision.originalFileName,
          mediaType: resolved.revision.mediaType,
          byteCount: resolved.revision.byteCount,
        })
      ) {
        throw new ShareNotFoundError();
      }
      const content: SealedContent = { ...stored.content };
      const signal = request.signal;
      return Object.freeze({
        revisionId: stored.revisionId,
        originalFileName: stored.originalFileName,
        byteCount: stored.content.byteCount,
        async read(): Promise<AsyncIterable<Uint8Array>> {
          let source: AsyncIterable<Uint8Array>;
          try {
            signal?.throwIfAborted();
            source = await dependencies.contentReader.read(content, {
              ...(signal === undefined ? {} : { signal }),
            });
          } catch (error) {
            throw boundaryFailure('CONTENT_UNAVAILABLE', 'Shared content is unavailable.', error);
          }
          return (async function* guardedContent() {
            try {
              for await (const chunk of source) {
                signal?.throwIfAborted();
                yield chunk;
              }
            } catch (error) {
              throw boundaryFailure('CONTENT_UNAVAILABLE', 'Shared content is unavailable.', error);
            }
          })();
        },
      });
    },

    async readTree(request: {
      shareId: string;
      secret: string;
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
      const resolved = await resolveShare(request);
      if (resolved.artifact.kind !== 'folder' || resolved.revision.kind !== 'folder') {
        throw new ShareNotFoundError();
      }
      let revision: StoredFolderRevision | undefined;
      try {
        request.signal?.throwIfAborted();
        revision = await dependencies.folders.findFolderRevision(resolved.revision.revisionId);
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Shared folder lookup failed.', error);
      }
      if (
        !validFolderScope(revision, {
          artifactId: resolved.artifact.artifactId,
          revisionId: resolved.revision.revisionId,
          rootName: resolved.revision.rootName,
          byteCount: resolved.revision.byteCount,
          fileCount: resolved.revision.fileCount,
        })
      ) {
        throw new ShareNotFoundError();
      }
      let page: Awaited<ReturnType<FolderRevisionRepository['listFolderEntries']>>;
      try {
        page = await dependencies.folders.listFolderEntries({
          installationId: revision.installationId,
          revisionId: revision.revisionId,
          limit: request.limit,
          ...(afterPath === undefined ? {} : { afterPath }),
        });
      } catch (error) {
        throw boundaryFailure('SERVICE_UNAVAILABLE', 'Shared folder tree lookup failed.', error);
      }
      return {
        apiVersion: 'v1',
        revisionId: revision.revisionId,
        contentHash: revision.manifest.contentHash,
        byteCount: revision.totalByteCount,
        fileCount: revision.fileCount,
        items: page.items.map(publicEntry),
        nextCursor: page.nextPath === undefined ? null : encodeCursor(page.nextPath),
      };
    },
  };
}
