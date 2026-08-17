import { describe, expect, it } from 'vitest';

import {
  AuthorizationDeniedError,
  type Authorizer,
  type ContentReader,
  createReadRevisionService,
  type RevisionRepository,
  ShelfCoreError,
  type StoredPublish,
} from '../src/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const stored: StoredPublish = {
  apiVersion: 'v1',
  installationId: 'install-local',
  workspaceId: 'workspace-main',
  artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  content: {
    contentId: `sha256:${'a'.repeat(64)}`,
    contentHash: `sha256:${'a'.repeat(64)}`,
    byteCount: 11,
  },
  originalFileName: 'README.md',
  mediaType: 'text/markdown',
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-publisher', operation: 'file.publish' },
  },
  publisherMetadata: { source: 'test' },
};

function repository(result: StoredPublish | undefined = stored): RevisionRepository {
  return {
    async findIdempotency() {
      return undefined;
    },
    async commitPublish() {
      throw new Error('not used');
    },
    async findRevision(revisionId) {
      return revisionId === stored.revisionId ? result : undefined;
    },
  };
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of content) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(joined);
}

describe('pinned revision read service', () => {
  it('authorizes the immutable revision before exposing its bytes', async () => {
    const observed: unknown[] = [];
    const contentReads: unknown[] = [];
    const authorizer: Authorizer = {
      async authorize(request) {
        observed.push(request);
      },
    };
    const contentReader: ContentReader = {
      async read(content, options) {
        contentReads.push({ content, options });
        const source = encoder.encode('hello shelf');
        const selected =
          options.range === undefined
            ? source
            : source.slice(options.range.start, options.range.end + 1);
        return (async function* bytes() {
          yield selected;
        })();
      },
    };
    const readRevision = createReadRevisionService({
      authorizer,
      contentReader,
      revisionRepository: repository(),
    });

    const revision = await readRevision({
      installationId: 'install-local',
      actorId: 'actor-reader',
      revisionId: stored.revisionId,
    });

    expect(observed).toEqual([
      {
        installationId: 'install-local',
        workspaceId: 'workspace-main',
        actorId: 'actor-reader',
        action: 'revision.read',
      },
    ]);
    expect(contentReads).toEqual([]);
    expect(revision).toMatchObject({
      revisionId: stored.revisionId,
      workspaceId: 'workspace-main',
      originalFileName: 'README.md',
      mediaType: 'text/markdown',
      contentHash: stored.content.contentHash,
      byteCount: 11,
    });

    expect(await collect(await revision.read({ start: 1, end: 4 }))).toBe('ello');
    expect(contentReads).toEqual([
      {
        content: stored.content,
        options: { range: { start: 1, end: 4 } },
      },
    ]);
  });

  it('does not touch content when authorization is denied', async () => {
    let contentReads = 0;
    const readRevision = createReadRevisionService({
      authorizer: {
        async authorize() {
          throw new AuthorizationDeniedError();
        },
      },
      contentReader: {
        async read() {
          contentReads += 1;
          throw new Error('must not be reached');
        },
      },
      revisionRepository: repository(),
    });

    await expect(
      readRevision({
        installationId: 'install-local',
        actorId: 'actor-other',
        revisionId: stored.revisionId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(contentReads).toBe(0);
  });

  it('does not disclose revisions from another installation', async () => {
    let authorizationCalls = 0;
    const readRevision = createReadRevisionService({
      authorizer: {
        async authorize() {
          authorizationCalls += 1;
        },
      },
      contentReader: {
        async read() {
          throw new Error('must not be reached');
        },
      },
      revisionRepository: repository(),
    });

    await expect(
      readRevision({
        installationId: 'install-other',
        actorId: 'actor-reader',
        revisionId: stored.revisionId,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });
    expect(authorizationCalls).toBe(0);
  });

  it('maps repository and content-reader failures to stable boundary errors', async () => {
    const unavailableRepository: RevisionRepository = {
      ...repository(),
      async findRevision() {
        throw new Error('database unavailable');
      },
    };
    const repositoryFailure = createReadRevisionService({
      authorizer: { async authorize() {} },
      contentReader: {
        async read() {
          throw new Error('not used');
        },
      },
      revisionRepository: unavailableRepository,
    });
    await expect(
      repositoryFailure({
        installationId: 'install-local',
        actorId: 'actor-reader',
        revisionId: stored.revisionId,
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const contentFailure = createReadRevisionService({
      authorizer: { async authorize() {} },
      contentReader: {
        async read() {
          return (async function* broken() {
            yield* [] as Uint8Array[];
            throw new Error('storage unavailable');
          })();
        },
      },
      revisionRepository: repository(),
    });
    const revision = await contentFailure({
      installationId: 'install-local',
      actorId: 'actor-reader',
      revisionId: stored.revisionId,
    });
    await expect(collect(await revision.read())).rejects.toMatchObject({
      code: 'CONTENT_UNAVAILABLE',
    });
  });

  it('preserves canonical core errors from adapters', async () => {
    const canonical = new ShelfCoreError('CONTENT_UNAVAILABLE', 'Already classified.', {
      retryable: true,
    });
    const readRevision = createReadRevisionService({
      authorizer: { async authorize() {} },
      contentReader: {
        async read() {
          throw canonical;
        },
      },
      revisionRepository: repository(),
    });
    const revision = await readRevision({
      installationId: 'install-local',
      actorId: 'actor-reader',
      revisionId: stored.revisionId,
    });

    await expect(revision.read()).rejects.toBe(canonical);
  });
});
