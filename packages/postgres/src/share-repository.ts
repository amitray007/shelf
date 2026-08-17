import type {
  CommitShareCreateInput,
  CommitShareCreateOutcome,
  ResolvedStoredShare,
  RevokeShareOutcome,
  ShareCreateIdempotencyNamespace,
  ShareCreateIdempotencyRecord,
  ShareRepository,
  StoredArtifact,
  StoredArtifactRevision,
  StoredShare,
  StoredShareRevision,
} from '@shelf/core';
import { sql, type Transaction } from 'kysely';

import type {
  RevisionRow,
  ShareTable,
  ShelfPostgresDatabase,
  ShelfPostgresSchema,
} from './database.js';

type DatabaseExecutor = ShelfPostgresDatabase | Transaction<ShelfPostgresSchema>;

type ArtifactWithLatestRow = RevisionRow & {
  artifact_name: string;
  artifact_kind: 'file' | 'folder';
  artifact_created_at: Date;
  artifact_updated_at: Date;
};

function parsePublisherMetadata(value: unknown): Record<string, string> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new Error('Stored publisher metadata is invalid.');
  }
  return value as Record<string, string>;
}

function safeInteger(value: string, options: { positive: boolean }): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (options.positive ? parsed < 1 : parsed < 0)) {
    throw new Error('Stored revision numeric value is invalid.');
  }
  return parsed;
}

function storedRevision(row: RevisionRow): StoredArtifactRevision {
  const provenance =
    row.provenance_classification === 'direct-publish' &&
    row.operation === 'file.publish' &&
    row.source_revision_id === null
      ? {
          classification: 'direct-publish' as const,
          observed: { actorId: row.actor_id, operation: 'file.publish' as const },
        }
      : row.provenance_classification === 'restore' &&
          row.operation === 'revision.restore' &&
          row.source_revision_id !== null
        ? {
            classification: 'restore' as const,
            observed: { actorId: row.actor_id, operation: 'revision.restore' as const },
            source: { revisionId: row.source_revision_id },
          }
        : undefined;
  if (provenance === undefined) throw new Error('Stored revision provenance is invalid.');

  const common = {
    revisionId: row.revision_id,
    revisionNumber: safeInteger(row.revision_number, { positive: true }),
    contentHash: row.content_hash,
    createdAt: row.created_at.toISOString(),
    provenance,
    publisherMetadata: parsePublisherMetadata(row.publisher_metadata),
  };
  if (row.kind === 'folder') {
    return {
      ...common,
      kind: 'folder',
      rootName: row.original_file_name,
      byteCount: safeInteger(row.total_byte_count, { positive: false }),
      fileCount: row.file_count,
    };
  }
  return {
    ...common,
    kind: 'file',
    originalFileName: row.original_file_name,
    mediaType: row.media_type,
    byteCount: safeInteger(row.byte_count, { positive: true }),
    fileCount: 1,
  };
}

function storedArtifact(row: ArtifactWithLatestRow): StoredArtifact {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    kind: row.artifact_kind,
    name: row.artifact_name,
    createdAt: row.artifact_created_at.toISOString(),
    updatedAt: row.artifact_updated_at.toISOString(),
    latestRevision: storedRevision(row),
  };
}

function storedShare(row: ShareTable): StoredShare {
  const target =
    row.target_mode === 'pinned' && row.target_revision_id !== null
      ? { mode: 'pinned' as const, revisionId: row.target_revision_id }
      : row.target_mode === 'latest' && row.target_revision_id === null
        ? { mode: 'latest' as const }
        : undefined;
  if (target === undefined) throw new Error('Stored share target is invalid.');
  return {
    apiVersion: 'v1',
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    shareId: row.share_id,
    artifactId: row.artifact_id,
    visibility: row.visibility,
    target,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedByActorId: row.revoked_by_actor_id,
  };
}

async function findArtifact(
  database: DatabaseExecutor,
  artifactId: string,
): Promise<StoredArtifact | undefined> {
  const row = await database
    .selectFrom('shelf_artifacts as artifact')
    .innerJoin('shelf_revisions as revision', (join) =>
      join
        .onRef('revision.revision_id', '=', 'artifact.latest_revision_id')
        .onRef('revision.installation_id', '=', 'artifact.installation_id')
        .onRef('revision.workspace_id', '=', 'artifact.workspace_id')
        .onRef('revision.artifact_id', '=', 'artifact.artifact_id'),
    )
    .selectAll('revision')
    .select([
      'artifact.name as artifact_name',
      'artifact.kind as artifact_kind',
      'artifact.created_at as artifact_created_at',
      'artifact.updated_at as artifact_updated_at',
    ])
    .where('artifact.artifact_id', '=', artifactId)
    .executeTakeFirst();
  return row === undefined ? undefined : storedArtifact(row);
}

async function findRevision(
  database: DatabaseExecutor,
  revisionId: string,
): Promise<StoredShareRevision | undefined> {
  const row = await database
    .selectFrom('shelf_revisions')
    .selectAll()
    .where('revision_id', '=', revisionId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : {
        installationId: row.installation_id,
        workspaceId: row.workspace_id,
        artifactId: row.artifact_id,
        revision: storedRevision(row),
      };
}

async function findShare(
  database: DatabaseExecutor,
  shareId: string,
): Promise<StoredShare | undefined> {
  const row = await database
    .selectFrom('shelf_shares')
    .selectAll()
    .where('share_id', '=', shareId)
    .executeTakeFirst();
  return row === undefined ? undefined : storedShare(row);
}

async function findIdempotency(
  database: DatabaseExecutor,
  namespace: ShareCreateIdempotencyNamespace,
): Promise<ShareCreateIdempotencyRecord | undefined> {
  const row = await database
    .selectFrom('shelf_share_idempotency as idempotency')
    .innerJoin('shelf_shares as share', (join) =>
      join
        .onRef('share.share_id', '=', 'idempotency.share_id')
        .onRef('share.installation_id', '=', 'idempotency.installation_id')
        .onRef('share.workspace_id', '=', 'idempotency.workspace_id')
        .onRef('share.created_by_actor_id', '=', 'idempotency.actor_id'),
    )
    .selectAll('share')
    .select('idempotency.fingerprint')
    .where('idempotency.installation_id', '=', namespace.installationId)
    .where('idempotency.workspace_id', '=', namespace.workspaceId)
    .where('idempotency.actor_id', '=', namespace.actorId)
    .where('idempotency.operation', '=', namespace.operation)
    .where('idempotency.client_key', '=', namespace.key)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const { fingerprint, ...share } = row;
  return { fingerprint, result: storedShare(share) };
}

function shareValues(result: StoredShare): ShareTable {
  return {
    share_id: result.shareId,
    installation_id: result.installationId,
    workspace_id: result.workspaceId,
    artifact_id: result.artifactId,
    visibility: result.visibility,
    target_mode: result.target.mode,
    target_revision_id: result.target.mode === 'pinned' ? result.target.revisionId : null,
    created_by_actor_id: result.createdByActorId,
    created_at: new Date(result.createdAt),
    expires_at: result.expiresAt === null ? null : new Date(result.expiresAt),
    revoked_at: result.revokedAt === null ? null : new Date(result.revokedAt),
    revoked_by_actor_id: result.revokedByActorId,
  };
}

export class PostgresShareRepository implements ShareRepository {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  findArtifactForShare(artifactId: string): Promise<StoredArtifact | undefined> {
    return findArtifact(this.#database, artifactId);
  }

  findRevisionForShare(revisionId: string): Promise<StoredShareRevision | undefined> {
    return findRevision(this.#database, revisionId);
  }

  findCreateIdempotency(
    namespace: ShareCreateIdempotencyNamespace,
  ): Promise<ShareCreateIdempotencyRecord | undefined> {
    return findIdempotency(this.#database, namespace);
  }

  commitCreate(input: CommitShareCreateInput): Promise<CommitShareCreateOutcome> {
    return this.#database.transaction().execute(async (transaction) => {
      const claim = await transaction
        .insertInto('shelf_share_idempotency')
        .values({
          installation_id: input.namespace.installationId,
          workspace_id: input.namespace.workspaceId,
          actor_id: input.namespace.actorId,
          operation: input.namespace.operation,
          client_key: input.namespace.key,
          fingerprint: input.fingerprint,
          share_id: input.result.shareId,
          created_at: sql`transaction_timestamp()`,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['installation_id', 'workspace_id', 'actor_id', 'operation', 'client_key'])
            .doNothing(),
        )
        .returning('share_id')
        .executeTakeFirst();

      if (claim !== undefined) {
        const inserted = await transaction
          .insertInto('shelf_shares')
          .values(shareValues(input.result))
          .returningAll()
          .executeTakeFirstOrThrow();
        return { status: 'committed', result: storedShare(inserted) };
      }

      const existing = await findIdempotency(transaction, input.namespace);
      if (existing === undefined) {
        throw new Error('Share idempotency claim disappeared during creation.');
      }
      return existing.fingerprint === input.fingerprint
        ? { status: 'replayed', result: existing.result }
        : { status: 'conflict' };
    });
  }

  async listShares(request: {
    installationId: string;
    workspaceId: string;
    limit: number;
    after?: { createdAt: string; shareId: string };
  }): Promise<{ items: StoredShare[]; next?: { createdAt: string; shareId: string } }> {
    let query = this.#database
      .selectFrom('shelf_shares')
      .selectAll()
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId);
    if (request.after !== undefined) {
      const after = request.after;
      const createdAt = new Date(after.createdAt);
      query = query.where((expressions) =>
        expressions.or([
          expressions('created_at', '<', createdAt),
          expressions.and([
            expressions('created_at', '=', createdAt),
            expressions('share_id', '>', after.shareId),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('share_id', 'asc')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(storedShare);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined
        ? { next: { createdAt: last.createdAt, shareId: last.shareId } }
        : {}),
    };
  }

  findShare(shareId: string): Promise<StoredShare | undefined> {
    return findShare(this.#database, shareId);
  }

  revokeShare(request: {
    installationId: string;
    workspaceId: string;
    shareId: string;
    revokedByActorId: string;
    revokedAt: string;
  }): Promise<RevokeShareOutcome> {
    return this.#database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable('shelf_shares')
        .set({
          revoked_at: new Date(request.revokedAt),
          revoked_by_actor_id: request.revokedByActorId,
        })
        .where('installation_id', '=', request.installationId)
        .where('workspace_id', '=', request.workspaceId)
        .where('share_id', '=', request.shareId)
        .where('revoked_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (updated !== undefined) return { status: 'revoked', result: storedShare(updated) };
      const existing = await transaction
        .selectFrom('shelf_shares')
        .selectAll()
        .where('installation_id', '=', request.installationId)
        .where('workspace_id', '=', request.workspaceId)
        .where('share_id', '=', request.shareId)
        .executeTakeFirst();
      return existing === undefined
        ? { status: 'not-found' }
        : { status: 'already-revoked', result: storedShare(existing) };
    });
  }

  resolveShareTarget(shareId: string): Promise<ResolvedStoredShare | undefined> {
    return this.#database
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (transaction) => {
        const share = await findShare(transaction, shareId);
        if (share === undefined) return undefined;
        const artifact = await findArtifact(transaction, share.artifactId);
        if (
          artifact === undefined ||
          artifact.installationId !== share.installationId ||
          artifact.workspaceId !== share.workspaceId
        ) {
          return undefined;
        }
        const revisionId =
          share.target.mode === 'pinned'
            ? share.target.revisionId
            : artifact.latestRevision.revisionId;
        const revision = await findRevision(transaction, revisionId);
        if (
          revision === undefined ||
          revision.installationId !== share.installationId ||
          revision.workspaceId !== share.workspaceId ||
          revision.artifactId !== share.artifactId
        ) {
          return undefined;
        }
        return { share, artifact, revision };
      });
  }
}
