import type {
  CommitPublishInput,
  CommitPublishOutcome,
  IdempotencyNamespace,
  IdempotencyRecord,
  RevisionRepository,
  StoredPublish,
} from '@shelf/core';

function namespaceKey(namespace: IdempotencyNamespace): string {
  return [
    namespace.installationId,
    namespace.workspaceId,
    namespace.actorId,
    namespace.operation,
    namespace.key,
  ].join('\u0000');
}

/** Process-local validation adapter. It deliberately does not settle Shelf's persistence model. */
export class MemoryRevisionRepository implements RevisionRepository {
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #revisions = new Map<string, StoredPublish>();

  async findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return this.#idempotency.get(namespaceKey(namespace));
  }

  async commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome> {
    // This method has no suspension point. JavaScript's run-to-completion rule makes the read and
    // both writes one process-local linearization point for concurrent callers.
    const key = namespaceKey(input.namespace);
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      return existing.fingerprint === input.fingerprint
        ? { status: 'replayed', result: existing.result }
        : { status: 'conflict' };
    }

    const record = Object.freeze({ fingerprint: input.fingerprint, result: input.result });
    this.#revisions.set(input.result.revisionId, input.result);
    this.#idempotency.set(key, record);
    return { status: 'committed', result: input.result };
  }

  async findRevision(revisionId: string): Promise<StoredPublish | undefined> {
    return this.#revisions.get(revisionId);
  }
}
