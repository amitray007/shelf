import type {
  ArtifactCatalogRepository,
  CommitPublishInput,
  CommitPublishOutcome,
  IdempotencyNamespace,
  IdempotencyRecord,
  RevisionRepository,
  StoredArtifact,
  StoredArtifactRevision,
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

function parseRevisionNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Stored revision number is invalid.');
  }
  return parsed;
}

function storedArtifactRevision(row: RevisionRow): StoredArtifactRevision {
  const publish = storedPublish(row);
  return {
    revisionId: publish.revisionId,
    revisionNumber: parseRevisionNumber(row.revision_number),
    originalFileName: publish.originalFileName,
    mediaType: publish.mediaType,
    contentHash: publish.content.contentHash,
    byteCount: publish.content.byteCount,
    createdAt: row.created_at.toISOString(),
    provenance: publish.provenance,
    publisherMetadata: publish.publisherMetadata,
  };
}

type ArtifactWithLatestRow = RevisionRow & {
  artifact_created_at: Date;
  artifact_updated_at: Date;
};

function storedArtifact(row: ArtifactWithLatestRow): StoredArtifact {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    createdAt: row.artifact_created_at.toISOString(),
    updatedAt: row.artifact_updated_at.toISOString(),
    latestRevision: storedArtifactRevision(row),
  };
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

export class PostgresRevisionRepository implements RevisionRepository, ArtifactCatalogRepository {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return findIdempotency(this.#database, namespace);
  }

  async findArtifactIdentity(artifactId: string) {
    const artifact = await this.#database
      .selectFrom('shelf_artifacts')
      .select(['artifact_id', 'installation_id', 'workspace_id'])
      .where('artifact_id', '=', artifactId)
      .executeTakeFirst();
    return artifact === undefined
      ? undefined
      : {
          artifactId: artifact.artifact_id,
          installationId: artifact.installation_id,
          workspaceId: artifact.workspace_id,
        };
  }

  async findArtifact(artifactId: string): Promise<StoredArtifact | undefined> {
    const row = await this.#database
      .selectFrom('shelf_artifacts as artifact')
      .innerJoin('shelf_revisions as revision', (join) =>
        join
          .onRef('revision.revision_id', '=', 'artifact.latest_revision_id')
          .onRef('revision.installation_id', '=', 'artifact.installation_id')
          .onRef('revision.workspace_id', '=', 'artifact.workspace_id'),
      )
      .selectAll('revision')
      .select([
        'artifact.created_at as artifact_created_at',
        'artifact.updated_at as artifact_updated_at',
      ])
      .where('artifact.artifact_id', '=', artifactId)
      .executeTakeFirst();
    return row === undefined ? undefined : storedArtifact(row);
  }

  async listArtifacts(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { updatedAt: string; artifactId: string };
  }) {
    let query = this.#database
      .selectFrom('shelf_artifacts as artifact')
      .innerJoin('shelf_revisions as revision', (join) =>
        join
          .onRef('revision.revision_id', '=', 'artifact.latest_revision_id')
          .onRef('revision.installation_id', '=', 'artifact.installation_id')
          .onRef('revision.workspace_id', '=', 'artifact.workspace_id'),
      )
      .selectAll('revision')
      .select([
        'artifact.created_at as artifact_created_at',
        'artifact.updated_at as artifact_updated_at',
      ])
      .where('artifact.installation_id', '=', request.installationId)
      .where('artifact.workspace_id', '=', request.workspaceId);
    if (request.after !== undefined) {
      const after = request.after;
      const updatedAt = new Date(after.updatedAt);
      query = query.where((expressions) =>
        expressions.or([
          expressions('artifact.updated_at', '<', updatedAt),
          expressions.and([
            expressions('artifact.updated_at', '=', updatedAt),
            expressions('artifact.artifact_id', '>', after.artifactId),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('artifact.updated_at', 'desc')
      .orderBy('artifact.artifact_id', 'asc')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(storedArtifact);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? { next: { updatedAt: last.updatedAt, artifactId: last.artifactId } }
        : {}),
    };
  }

  async listArtifactRevisions(request: {
    installationId: string;
    artifactId: string;
    limit: number;
    beforeRevisionNumber?: number;
  }) {
    let query = this.#database
      .selectFrom('shelf_revisions')
      .selectAll()
      .where('installation_id', '=', request.installationId)
      .where('artifact_id', '=', request.artifactId);
    if (request.beforeRevisionNumber !== undefined) {
      query = query.where('revision_number', '<', String(request.beforeRevisionNumber));
    }
    const rows = await query
      .orderBy('revision_number', 'desc')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(storedArtifactRevision);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { nextRevisionNumber: last.revisionNumber } : {}),
    };
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
