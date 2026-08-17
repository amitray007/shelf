import type {
  CommitPublishInput,
  CommitPublishOutcome,
  IdempotencyNamespace,
  IdempotencyRecord,
  RevisionRepository,
  StoredPublish,
} from '@shelf/core';
import { sql, type Transaction } from 'kysely';

import type { RevisionRow, ShelfPostgresDatabase, ShelfPostgresSchema } from './database.js';

type DatabaseExecutor = ShelfPostgresDatabase | Transaction<ShelfPostgresSchema>;

function parsePublisherMetadata(value: unknown): StoredPublish['publisherMetadata'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored publisher metadata is invalid.');
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== 'string')) {
    throw new Error('Stored publisher metadata is invalid.');
  }
  return Object.fromEntries(entries) as StoredPublish['publisherMetadata'];
}

function parseByteCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Stored content byte count is invalid.');
  }
  return parsed;
}

function storedPublish(row: RevisionRow): StoredPublish {
  if (row.provenance_classification !== 'direct-publish' || row.operation !== 'file.publish') {
    throw new Error('Stored revision provenance is invalid.');
  }
  return {
    apiVersion: 'v1',
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    revisionId: row.revision_id,
    content: {
      contentId: row.content_id,
      contentHash: row.content_hash,
      byteCount: parseByteCount(row.byte_count),
    },
    originalFileName: row.original_file_name,
    mediaType: row.media_type,
    provenance: {
      classification: row.provenance_classification,
      observed: { actorId: row.actor_id, operation: row.operation },
    },
    publisherMetadata: parsePublisherMetadata(row.publisher_metadata),
  };
}

async function findRevision(
  database: DatabaseExecutor,
  revisionId: string,
): Promise<StoredPublish | undefined> {
  const row = await database
    .selectFrom('shelf_revisions')
    .selectAll()
    .where('revision_id', '=', revisionId)
    .executeTakeFirst();
  return row === undefined ? undefined : storedPublish(row);
}

async function findIdempotency(
  database: DatabaseExecutor,
  namespace: IdempotencyNamespace,
): Promise<IdempotencyRecord | undefined> {
  const row = await database
    .selectFrom('shelf_idempotency as idempotency')
    .innerJoin('shelf_revisions as revision', 'revision.revision_id', 'idempotency.revision_id')
    .selectAll('revision')
    .select('idempotency.fingerprint')
    .where('idempotency.installation_id', '=', namespace.installationId)
    .where('idempotency.workspace_id', '=', namespace.workspaceId)
    .where('idempotency.actor_id', '=', namespace.actorId)
    .where('idempotency.operation', '=', namespace.operation)
    .where('idempotency.client_key', '=', namespace.key)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const { fingerprint, ...revision } = row;
  return { fingerprint, result: storedPublish(revision) };
}

async function commitNewPublish(
  transaction: Transaction<ShelfPostgresSchema>,
  input: CommitPublishInput,
): Promise<CommitPublishOutcome> {
  const claim = await transaction
    .insertInto('shelf_idempotency')
    .values({
      installation_id: input.namespace.installationId,
      workspace_id: input.namespace.workspaceId,
      actor_id: input.namespace.actorId,
      operation: input.namespace.operation,
      client_key: input.namespace.key,
      fingerprint: input.fingerprint,
      revision_id: input.result.revisionId,
      created_at: sql`transaction_timestamp()`,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['installation_id', 'workspace_id', 'actor_id', 'operation', 'client_key'])
        .doNothing(),
    )
    .returning('revision_id')
    .executeTakeFirst();

  if (claim === undefined) {
    const existing = await findIdempotency(transaction, input.namespace);
    if (existing === undefined) throw new Error('Idempotency conflict resolved without a record.');
    return existing.fingerprint === input.fingerprint
      ? { status: 'replayed', result: existing.result }
      : { status: 'conflict' };
  }

  await transaction
    .insertInto('shelf_artifacts')
    .values({
      artifact_id: input.result.artifactId,
      installation_id: input.result.installationId,
      workspace_id: input.result.workspaceId,
      latest_revision_id: null,
      created_at: sql`transaction_timestamp()`,
      updated_at: sql`transaction_timestamp()`,
    })
    .onConflict((conflict) => conflict.column('artifact_id').doNothing())
    .execute();

  const artifact = await transaction
    .selectFrom('shelf_artifacts')
    .select(['installation_id', 'workspace_id'])
    .where('artifact_id', '=', input.result.artifactId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    artifact.installation_id !== input.result.installationId ||
    artifact.workspace_id !== input.result.workspaceId
  ) {
    throw new Error('Artifact identity belongs to another workspace.');
  }

  const ordinal = await transaction
    .selectFrom('shelf_revisions')
    .select(sql<string>`coalesce(max(revision_number), 0) + 1`.as('next_revision_number'))
    .where('artifact_id', '=', input.result.artifactId)
    .executeTakeFirstOrThrow();

  await transaction
    .insertInto('shelf_revisions')
    .values({
      revision_id: input.result.revisionId,
      installation_id: input.result.installationId,
      workspace_id: input.result.workspaceId,
      artifact_id: input.result.artifactId,
      revision_number: ordinal.next_revision_number,
      content_id: input.result.content.contentId,
      content_hash: input.result.content.contentHash,
      byte_count: String(input.result.content.byteCount),
      original_file_name: input.result.originalFileName,
      media_type: input.result.mediaType,
      provenance_classification: input.result.provenance.classification,
      actor_id: input.result.provenance.observed.actorId,
      operation: input.result.provenance.observed.operation,
      publisher_metadata: input.result.publisherMetadata,
      created_at: sql`transaction_timestamp()`,
    })
    .execute();

  await transaction
    .updateTable('shelf_artifacts')
    .set({
      latest_revision_id: input.result.revisionId,
      updated_at: sql`transaction_timestamp()`,
    })
    .where('artifact_id', '=', input.result.artifactId)
    .executeTakeFirstOrThrow();

  return { status: 'committed', result: input.result };
}

export class PostgresRevisionRepository implements RevisionRepository {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return findIdempotency(this.#database, namespace);
  }

  commitPublish(input: CommitPublishInput): Promise<CommitPublishOutcome> {
    return this.#database
      .transaction()
      .execute((transaction) => commitNewPublish(transaction, input));
  }

  findRevision(revisionId: string): Promise<StoredPublish | undefined> {
    return findRevision(this.#database, revisionId);
  }
}
