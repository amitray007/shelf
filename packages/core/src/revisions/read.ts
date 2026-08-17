import { READ_REVISION_OPERATION } from '@shelf/contracts';

import { boundaryFailure, ShelfCoreError } from '../errors.js';
import type {
  Authorizer,
  ContentByteRange,
  ContentReader,
  RevisionRepository,
  StoredRevision,
} from '../publishing/ports.js';

export interface ReadRevisionRequest {
  installationId: string;
  actorId: string;
  revisionId: string;
  signal?: AbortSignal;
}

export interface AuthorizedRevision {
  revisionId: string;
  workspaceId: string;
  originalFileName: string;
  mediaType: string;
  contentHash: string;
  byteCount: number;
  read(range?: ContentByteRange): Promise<AsyncIterable<Uint8Array>>;
}

export interface ReadRevisionServiceDependencies {
  authorizer: Authorizer;
  contentReader: ContentReader;
  revisionRepository: RevisionRepository;
}

export class RevisionNotFoundError extends ShelfCoreError {
  constructor() {
    super('REVISION_NOT_FOUND', 'The requested revision was not found.', { retryable: false });
    this.name = 'RevisionNotFoundError';
  }
}

function authorizedRevision(
  stored: StoredRevision,
  contentReader: ContentReader,
  signal?: AbortSignal,
): AuthorizedRevision {
  return Object.freeze({
    revisionId: stored.revisionId,
    workspaceId: stored.workspaceId,
    originalFileName: stored.originalFileName,
    mediaType: stored.mediaType,
    contentHash: stored.content.contentHash,
    byteCount: stored.content.byteCount,
    async read(range?: ContentByteRange): Promise<AsyncIterable<Uint8Array>> {
      let source: AsyncIterable<Uint8Array>;
      try {
        signal?.throwIfAborted();
        source = await contentReader.read(stored.content, {
          ...(range === undefined ? {} : { range }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw boundaryFailure('CONTENT_UNAVAILABLE', 'Revision content is unavailable.', error);
      }

      return (async function* guardedContent() {
        try {
          for await (const chunk of source) {
            signal?.throwIfAborted();
            yield chunk;
          }
        } catch (error) {
          throw boundaryFailure('CONTENT_UNAVAILABLE', 'Revision content is unavailable.', error);
        }
      })();
    },
  });
}

export function createReadRevisionService(dependencies: ReadRevisionServiceDependencies) {
  return async function readRevision(request: ReadRevisionRequest): Promise<AuthorizedRevision> {
    let stored: StoredRevision | undefined;
    try {
      request.signal?.throwIfAborted();
      stored = await dependencies.revisionRepository.findRevision(request.revisionId);
    } catch (error) {
      throw boundaryFailure('SERVICE_UNAVAILABLE', 'Revision lookup failed.', error);
    }

    // Installation boundaries are deliberately non-enumerable.
    if (stored === undefined || stored.installationId !== request.installationId) {
      throw new RevisionNotFoundError();
    }

    await dependencies.authorizer.authorize(
      {
        installationId: request.installationId,
        workspaceId: stored.workspaceId,
        actorId: request.actorId,
        action: READ_REVISION_OPERATION,
      },
      request.signal,
    );
    request.signal?.throwIfAborted();

    return authorizedRevision(stored, dependencies.contentReader, request.signal);
  };
}
