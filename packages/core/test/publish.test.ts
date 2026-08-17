import { describe, expect, it } from 'vitest';

import {
  AuthorizationDeniedError,
  type Authorizer,
  type CommitPublishInput,
  type CommitPublishOutcome,
  type ContentStore,
  createOpaqueId,
  createPublishFingerprint,
  createPublishService,
  IdempotencyConflictError,
  type IdempotencyNamespace,
  InvalidPublishRequestError,
  PublishCancelledError,
  type PublishFileRequest,
  type RevisionRepository,
  type SealedContent,
  ShelfCoreError,
  type StagedContent,
  type StoredPublish,
} from '../src/index.js';

const encoder = new TextEncoder();

function bytes(value: string): AsyncIterable<Uint8Array> {
  return (async function* content() {
    yield encoder.encode(value);
  })();
}

function namespaceKey(namespace: IdempotencyNamespace): string {
  return [
    namespace.installationId,
    namespace.workspaceId,
    namespace.actorId,
    namespace.operation,
    namespace.key,
  ].join('\u0000');
}

class TestContentStore implements ContentStore {
  readonly sealed = new Map<string, Uint8Array>();
  readonly staged = new Map<string, Uint8Array>();
  failStage = false;
  failSeal = false;
  afterStage?: () => void;
  afterSeal?: () => void;
  #nextStage = 0;

  async stage(
    content: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal },
  ): Promise<StagedContent> {
    if (this.failStage) throw new Error('stage failed');
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      options.signal?.throwIfAborted();
      chunks.push(chunk.slice());
    }
    const byteCount = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const stagedBytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      stagedBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const stageId = `stage-${this.#nextStage++}`;
    this.staged.set(stageId, stagedBytes);
    this.afterStage?.();
    return { stageId };
  }

  async discard(staged: StagedContent): Promise<void> {
    this.staged.delete(staged.stageId);
  }

  async seal(
    staged: StagedContent,
    descriptor: { contentHash: string; byteCount: number },
  ): Promise<SealedContent> {
    if (this.failSeal) throw new Error('seal failed');
    const content = this.staged.get(staged.stageId);
    if (content === undefined) throw new Error('missing staged content');
    this.staged.delete(staged.stageId);
    this.sealed.set(descriptor.contentHash, content);
    const sealed = { contentId: descriptor.contentHash, ...descriptor };
    this.afterSeal?.();
    return sealed;
  }
}

class TestRevisionRepository implements RevisionRepository {
  readonly artifacts = new Map<
    string,
    { artifactId: string; installationId: string; workspaceId: string }
  >();
  readonly revisions = new Map<string, StoredPublish>();
  readonly records = new Map<string, { fingerprint: string; result: StoredPublish }>();
  failBeforeCommit = false;
  failAfterCommit = false;
  afterCommit?: () => void;

  async findIdempotency(namespace: IdempotencyNamespace) {
    return this.records.get(namespaceKey(namespace));
  }

  async findArtifactIdentity(artifactId: string) {
    return this.artifacts.get(artifactId);
  }

  async commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome> {
    if (this.failBeforeCommit) throw new Error('commit failed before visibility');
    const key = namespaceKey(input.namespace);
    const existing = this.records.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? { status: 'replayed', result: existing.result }
        : { status: 'conflict' };
    }
    this.records.set(key, { fingerprint: input.fingerprint, result: input.result });
    this.revisions.set(input.result.revisionId, input.result);
    this.artifacts.set(input.result.artifactId, {
      artifactId: input.result.artifactId,
      installationId: input.result.installationId,
      workspaceId: input.result.workspaceId,
    });
    this.afterCommit?.();
    if (this.failAfterCommit) throw new Error('response lost after commit');
    return { status: 'committed', result: input.result };
  }

  async findRevision(revisionId: string): Promise<StoredPublish | undefined> {
    return this.revisions.get(revisionId);
  }
}

const allowAll: Authorizer = {
  async authorize() {},
};

function request(
  content = 'hello shelf',
  overrides: Partial<Omit<PublishFileRequest, 'content'>> = {},
): PublishFileRequest {
  return {
    installationId: 'install-local',
    workspaceId: 'workspace-main',
    actorId: 'actor-agent',
    requestId: 'req-current',
    idempotencyKey: 'publish-readme',
    originalFileName: 'README.md',
    mediaType: 'text/markdown',
    publisherMetadata: { source: 'test', title: 'Shelf' },
    ...overrides,
    content: bytes(content),
  };
}

function service(contentStore: ContentStore, revisionRepository: RevisionRepository) {
  let nextId = 0;
  return createPublishService({
    authorizer: allowAll,
    artifactRepository: revisionRepository as TestRevisionRepository,
    contentStore,
    revisionRepository,
    generateId(kind) {
      nextId += 1;
      return `${kind}_${String(nextId).padStart(22, 'A')}`;
    },
  });
}

describe('publish service', () => {
  it('publishes another immutable revision to the same stable artifact', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    const first = await publish(request('version one', { idempotencyKey: 'create-artifact' }));
    const second = await publish(
      request('version two', {
        artifactId: first.artifactId,
        idempotencyKey: 'revise-artifact',
        originalFileName: 'CHANGELOG.md',
      }),
    );

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.revisionId).not.toBe(first.revisionId);
    expect(revisionRepository.revisions.size).toBe(2);
  });

  it('includes the target artifact in revision-publish idempotency semantics', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);
    const first = await publish(request('first', { idempotencyKey: 'create-first' }));
    const second = await publish(request('second', { idempotencyKey: 'create-second' }));
    await publish(
      request('same bytes', {
        artifactId: first.artifactId,
        idempotencyKey: 'target-sensitive-key',
      }),
    );

    await expect(
      publish(
        request('same bytes', {
          artifactId: second.artifactId,
          idempotencyKey: 'target-sensitive-key',
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects an unknown revision target before consuming content', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    await expect(
      publish(
        request('version two', {
          artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
          idempotencyKey: 'missing-artifact',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    expect(contentStore.staged.size).toBe(0);
    expect(contentStore.sealed.size).toBe(0);
    expect(revisionRepository.revisions.size).toBe(0);
  });

  it('commits once, replays an identical scoped request, and conflicts on changed input', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    const first = await publish(request());
    const replay = await publish({ ...request(), requestId: 'req-retry' });

    expect(first).toMatchObject({
      apiVersion: 'v1',
      workspaceId: 'workspace-main',
      contentHash: `sha256:${'36bf0cb1e16ce25c61a2a17850928330a2b5ecf08b4a9d30cf9f5fad29f8c1a4'}`,
      byteCount: 11,
      requestId: 'req-current',
      replayed: false,
      provenance: {
        classification: 'direct-publish',
        observed: { actorId: 'actor-agent', operation: 'file.publish' },
      },
    });
    expect(replay).toEqual({ ...first, requestId: 'req-retry', replayed: true });
    expect(revisionRepository.revisions.size).toBe(1);

    await expect(publish(request('different bytes'))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(revisionRepository.revisions.size).toBe(1);
  });

  it('namespaces the same client key by installation, workspace, and actor', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    const results = await Promise.all([
      publish(request()),
      publish(request('hello shelf', { installationId: 'install-other' })),
      publish(request('hello shelf', { workspaceId: 'workspace-other' })),
      publish(request('hello shelf', { actorId: 'actor-other' })),
    ]);

    expect(new Set(results.map((result) => result.revisionId)).size).toBe(4);
    expect(revisionRepository.revisions.size).toBe(4);
  });

  it('uses a versioned canonical fingerprint independent of metadata property order', () => {
    const input = {
      contentHash: `sha256:${'36bf0cb1e16ce25c61a2a17850928330a2b5ecf08b4a9d30cf9f5fad29f8c1a4'}`,
      originalFileName: 'README.md',
      mediaType: 'text/markdown',
      publisherMetadata: { title: 'Shelf', source: 'test' },
    };

    expect(createPublishFingerprint(input)).toBe(
      `publish-request/v1:sha256:${'96ab3e93b4d7f0079ac6f6684e00f27cc6d75445db73c05ecfcf3a1e574b8a22'}`,
    );
    expect(
      createPublishFingerprint({
        ...input,
        publisherMetadata: { source: 'test', title: 'Shelf' },
      }),
    ).toBe(createPublishFingerprint(input));
  });

  it.each([
    ['original file name', { originalFileName: 'CHANGELOG.md' }],
    ['media type', { mediaType: 'text/plain' }],
    ['publisher metadata', { publisherMetadata: { source: 'other' } }],
  ])('conflicts when the same key changes %s', async (_label, overrides) => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);
    await publish(request());

    await expect(publish(request('hello shelf', overrides))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('linearizes concurrent identical retries into one revision', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        publish(request('hello shelf', { requestId: `req-race-${index}` })),
      ),
    );

    expect(new Set(results.map((result) => result.revisionId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(revisionRepository.revisions.size).toBe(1);
  });

  it('linearizes conflicting concurrent requests without exposing a broken revision', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    const results = await Promise.allSettled([
      publish(request('first contender')),
      publish(request('second contender')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(revisionRepository.revisions.size).toBe(1);
  });

  it('authorizes the explicit actor, workspace, and publish action before consuming content', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const observed: unknown[] = [];
    const publish = createPublishService({
      authorizer: {
        async authorize(value) {
          observed.push(value);
          throw new AuthorizationDeniedError();
        },
      },
      artifactRepository: revisionRepository,
      contentStore,
      revisionRepository,
    });

    await expect(publish(request())).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(observed).toEqual([
      {
        installationId: 'install-local',
        workspaceId: 'workspace-main',
        actorId: 'actor-agent',
        action: 'file.publish',
      },
    ]);
    expect(contentStore.staged.size).toBe(0);
  });

  it.each([
    ['artifact ID', { artifactId: 'art_not-valid' }],
    ['reserved provenance', { publisherMetadata: { actorId: 'forged' } }],
    [
      'metadata key count',
      {
        publisherMetadata: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`key-${index}`, 'value']),
        ),
      },
    ],
    ['metadata key length', { publisherMetadata: { ['k'.repeat(65)]: 'value' } }],
    ['metadata value length', { publisherMetadata: { key: 'v'.repeat(2049) } }],
  ])('rejects invalid %s without staging content', async (_label, overrides) => {
    const contentStore = new TestContentStore();
    const publish = service(contentStore, new TestRevisionRepository());

    await expect(publish(request('hello shelf', overrides))).rejects.toBeInstanceOf(
      InvalidPublishRequestError,
    );
    expect(contentStore.staged.size).toBe(0);
    expect(contentStore.sealed.size).toBe(0);
  });

  it('rejects an empty file before sealing or committing it', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    await expect(publish(request(''))).rejects.toBeInstanceOf(InvalidPublishRequestError);
    expect(contentStore.staged.size).toBe(0);
    expect(contentStore.sealed.size).toBe(0);
    expect(revisionRepository.revisions.size).toBe(0);
  });

  it('leaves no visible state when staging or sealing fails', async () => {
    for (const failure of ['stage', 'seal'] as const) {
      const contentStore = new TestContentStore();
      const revisionRepository = new TestRevisionRepository();
      contentStore.failStage = failure === 'stage';
      contentStore.failSeal = failure === 'seal';
      const publish = service(contentStore, revisionRepository);

      await expect(publish(request())).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
      expect(contentStore.staged.size).toBe(0);
      expect(revisionRepository.revisions.size).toBe(0);
      expect(revisionRepository.records.size).toBe(0);
    }
  });

  it('leaves no visible or successful idempotency state when the input stream aborts', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);
    const content = (async function* interruptedContent() {
      yield encoder.encode('partial');
      throw new Error('input interrupted');
    })();

    await expect(publish({ ...request(), content })).rejects.toMatchObject({
      code: 'CONTENT_UNAVAILABLE',
    });
    expect(contentStore.staged.size).toBe(0);
    expect(contentStore.sealed.size).toBe(0);
    expect(revisionRepository.revisions.size).toBe(0);
    expect(revisionRepository.records.size).toBe(0);
  });

  it('cleans staging when cancelled before sealing', async () => {
    const controller = new AbortController();
    const contentStore = new TestContentStore();
    contentStore.afterStage = () => controller.abort(new Error('client disconnected'));
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    await expect(
      publish(request('hello shelf', { signal: controller.signal })),
    ).rejects.toBeInstanceOf(PublishCancelledError);
    expect(contentStore.staged.size).toBe(0);
    expect(contentStore.sealed.size).toBe(0);
    expect(revisionRepository.revisions.size).toBe(0);
  });

  it('allows an unreachable sealed orphan but no revision when cancelled after sealing', async () => {
    const controller = new AbortController();
    const contentStore = new TestContentStore();
    contentStore.afterSeal = () => controller.abort(new Error('client disconnected'));
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);

    await expect(
      publish(request('hello shelf', { signal: controller.signal })),
    ).rejects.toBeInstanceOf(PublishCancelledError);
    expect(contentStore.sealed.size).toBe(1);
    expect(revisionRepository.revisions.size).toBe(0);
    expect(revisionRepository.records.size).toBe(0);
  });

  it('keeps pre-commit failure invisible and post-commit failure replayable', async () => {
    const beforeStore = new TestContentStore();
    const beforeRepository = new TestRevisionRepository();
    beforeRepository.failBeforeCommit = true;
    await expect(service(beforeStore, beforeRepository)(request())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(beforeRepository.revisions.size).toBe(0);
    expect(beforeRepository.records.size).toBe(0);

    const afterStore = new TestContentStore();
    const afterRepository = new TestRevisionRepository();
    afterRepository.failAfterCommit = true;
    const publish = service(afterStore, afterRepository);
    await expect(publish(request())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(afterRepository.revisions.size).toBe(1);
    expect(afterRepository.records.size).toBe(1);

    afterRepository.failAfterCommit = false;
    await expect(
      publish(request('hello shelf', { requestId: 'req-recovered' })),
    ).resolves.toMatchObject({ replayed: true, requestId: 'req-recovered' });
  });

  it('does not cancel the atomic commit and recovers through replay when cancellation wins the response', async () => {
    const controller = new AbortController();
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    revisionRepository.afterCommit = () => controller.abort(new Error('response disconnected'));
    const publish = service(contentStore, revisionRepository);

    await expect(
      publish(request('hello shelf', { signal: controller.signal })),
    ).rejects.toBeInstanceOf(PublishCancelledError);
    expect(revisionRepository.revisions.size).toBe(1);
    delete revisionRepository.afterCommit;

    await expect(
      publish(request('hello shelf', { requestId: 'req-after-cancel' })),
    ).resolves.toMatchObject({ replayed: true, requestId: 'req-after-cancel' });
  });

  it('generates opaque non-sequential identifiers with 128 bits of random input', () => {
    const artifacts = Array.from({ length: 128 }, () => createOpaqueId('art'));
    const revisions = Array.from({ length: 128 }, () => createOpaqueId('rev'));

    expect(new Set(artifacts).size).toBe(artifacts.length);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(artifacts.every((id) => /^art_[A-Za-z0-9_-]{22}$/.test(id))).toBe(true);
    expect(revisions.every((id) => /^rev_[A-Za-z0-9_-]{22}$/.test(id))).toBe(true);
  });

  it('does not let response mutation alter the immutable committed revision', async () => {
    const contentStore = new TestContentStore();
    const revisionRepository = new TestRevisionRepository();
    const publish = service(contentStore, revisionRepository);
    const first = await publish(request());

    first.publisherMetadata.title = 'mutated response';
    first.paths.content = '/mutated';
    const replay = await publish(request('hello shelf', { requestId: 'req-replay' }));

    expect(replay.publisherMetadata.title).toBe('Shelf');
    expect(replay.paths.content).toBe(`/api/v1/revisions/${replay.revisionId}/content`);
  });

  it('preserves stable public failure fields without leaking an internal cause', () => {
    const cause = new Error('/tmp/private-stage: credential=secret');
    const error = new ShelfCoreError('CONTENT_UNAVAILABLE', 'Content staging failed.', {
      retryable: true,
      cause,
    });

    expect({ code: error.code, message: error.message, retryable: error.retryable }).toEqual({
      code: 'CONTENT_UNAVAILABLE',
      message: 'Content staging failed.',
      retryable: true,
    });
    expect(error.message).not.toContain('/tmp/private-stage');
  });
});
