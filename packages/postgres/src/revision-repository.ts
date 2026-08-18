import type {
  ArtifactCatalogRepository,
  ArtifactDeletionRepository,
  ArtifactLifecycleRepository,
  ArtifactRecoveryIdempotencyNamespace,
  CommitFolderPublishInput,
  CommitFolderPublishOutcome,
  CommitPublishInput,
  CommitPublishOutcome,
  CommitRestoreInput,
  CommitRestoreOutcome,
  FolderIdempotencyRecord,
  FolderRevisionRepository,
  IdempotencyNamespace,
  IdempotencyRecord,
  RestoreIdempotencyNamespace,
  RestoreIdempotencyRecord,
  RevisionComparisonRepository,
  RevisionRepository,
  StoredArtifact,
  StoredArtifactDeletionState,
  StoredArtifactRevision,
  StoredFolderEntry,
  StoredFolderPublish,
  StoredFolderRestore,
  StoredFolderRevision,
  StoredPublish,
  StoredRestore,
  StoredRevision,
} from '@shelf/core';
import { initialArtifactNameFromFileName } from '@shelf/core';
import { sql, type Transaction } from 'kysely';

import type { RevisionRow, ShelfPostgresDatabase, ShelfPostgresSchema } from './database.js';

type DatabaseExecutor = ShelfPostgresDatabase | Transaction<ShelfPostgresSchema>;

interface StoredRecoveryIdempotency {
  fingerprint: string;
  artifact: StoredArtifact;
}

function parsePublisherMetadata(value: unknown): StoredRevision['publisherMetadata'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored publisher metadata is invalid.');
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== 'string')) {
    throw new Error('Stored publisher metadata is invalid.');
  }
  return Object.fromEntries(entries) as StoredRevision['publisherMetadata'];
}

function parseByteCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Stored content byte count is invalid.');
  }
  return parsed;
}

function parseNonNegativeByteCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Stored aggregate byte count is invalid.');
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
  if (row.kind === 'folder') {
    return {
      kind: 'folder',
      revisionId: row.revision_id,
      revisionNumber: parseRevisionNumber(row.revision_number),
      rootName: row.original_file_name,
      contentHash: row.content_hash,
      byteCount: parseNonNegativeByteCount(row.total_byte_count),
      fileCount: row.file_count,
      createdAt: row.created_at.toISOString(),
      provenance: storedProvenance(row),
      publisherMetadata: parsePublisherMetadata(row.publisher_metadata),
    };
  }
  const publish = storedRevision(row);
  return {
    kind: 'file',
    revisionId: publish.revisionId,
    revisionNumber: parseRevisionNumber(row.revision_number),
    originalFileName: publish.originalFileName,
    mediaType: publish.mediaType,
    contentHash: publish.content.contentHash,
    byteCount: publish.content.byteCount,
    fileCount: 1,
    createdAt: row.created_at.toISOString(),
    provenance: publish.provenance,
    publisherMetadata: publish.publisherMetadata,
  };
}

type ArtifactWithLatestRow = RevisionRow & {
  artifact_name: string;
  artifact_kind: 'file' | 'folder';
  artifact_created_at: Date;
  artifact_updated_at: Date;
};

type ArtifactDeletionRow = ArtifactWithLatestRow & {
  artifact_deleted_at: Date | null;
  artifact_recoverable_until: Date | null;
};

function storedArtifact(row: ArtifactWithLatestRow): StoredArtifact {
  return {
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    kind: row.artifact_kind,
    name: row.artifact_name,
    createdAt: row.artifact_created_at.toISOString(),
    updatedAt: row.artifact_updated_at.toISOString(),
    latestRevision: storedArtifactRevision(row),
  };
}

async function findArtifactDeletionState(
  database: DatabaseExecutor,
  artifactId: string,
): Promise<StoredArtifactDeletionState | undefined> {
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
      'artifact.deleted_at as artifact_deleted_at',
      'artifact.recoverable_until as artifact_recoverable_until',
    ])
    .where('artifact.artifact_id', '=', artifactId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const value = row as ArtifactDeletionRow;
  return {
    artifact: storedArtifact(value),
    deletedAt: value.artifact_deleted_at?.toISOString() ?? null,
    recoverableUntil: value.artifact_recoverable_until?.toISOString() ?? null,
  };
}

function parseStoredRecoveryArtifact(value: unknown): StoredArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored artifact recovery result is invalid.');
  }
  const artifact = value as Partial<StoredArtifact>;
  if (
    typeof artifact.installationId !== 'string' ||
    typeof artifact.workspaceId !== 'string' ||
    typeof artifact.artifactId !== 'string' ||
    (artifact.kind !== 'file' && artifact.kind !== 'folder') ||
    typeof artifact.name !== 'string' ||
    typeof artifact.createdAt !== 'string' ||
    typeof artifact.updatedAt !== 'string' ||
    typeof artifact.latestRevision !== 'object' ||
    artifact.latestRevision === null
  ) {
    throw new Error('Stored artifact recovery result is invalid.');
  }
  return structuredClone(artifact as StoredArtifact);
}

async function findRecoveryIdempotency(
  database: DatabaseExecutor,
  namespace: ArtifactRecoveryIdempotencyNamespace,
): Promise<StoredRecoveryIdempotency | undefined> {
  const row = await database
    .selectFrom('shelf_artifact_recovery_idempotency')
    .select(['fingerprint', 'artifact_id', 'result'])
    .where('installation_id', '=', namespace.installationId)
    .where('workspace_id', '=', namespace.workspaceId)
    .where('actor_id', '=', namespace.actorId)
    .where('operation', '=', namespace.operation)
    .where('client_key', '=', namespace.key)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const artifact = parseStoredRecoveryArtifact(row.result);
  if (
    artifact.installationId !== namespace.installationId ||
    artifact.workspaceId !== namespace.workspaceId ||
    artifact.artifactId !== row.artifact_id
  ) {
    throw new Error('Stored artifact recovery idempotency scope is invalid.');
  }
  return { fingerprint: row.fingerprint, artifact };
}

function storedProvenance(row: RevisionRow): StoredRevision['provenance'] {
  if (
    row.provenance_classification === 'direct-publish' &&
    row.operation === 'file.publish' &&
    row.source_revision_id === null
  ) {
    return {
      classification: 'direct-publish',
      observed: { actorId: row.actor_id, operation: 'file.publish' },
    };
  }
  if (
    row.provenance_classification === 'restore' &&
    row.operation === 'revision.restore' &&
    row.source_revision_id !== null
  ) {
    return {
      classification: 'restore',
      observed: { actorId: row.actor_id, operation: 'revision.restore' },
      source: { revisionId: row.source_revision_id },
    };
  }
  throw new Error('Stored revision provenance is invalid.');
}

function storedRevision(row: RevisionRow): StoredRevision {
  if (row.kind !== 'file') throw new Error('Folder revision requires the folder repository seam.');
  const common = {
    apiVersion: 'v1' as const,
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
    publisherMetadata: parsePublisherMetadata(row.publisher_metadata),
  };
  const provenance = storedProvenance(row);
  if (provenance.classification === 'direct-publish') {
    return {
      ...common,
      provenance,
    };
  }
  return { ...common, provenance };
}

function storedFolderPublish(row: RevisionRow): StoredFolderPublish {
  const revision = storedFolderRevision(row);
  if (!isStoredFolderPublish(revision)) {
    throw new Error('Stored folder publish provenance is invalid.');
  }
  return revision;
}

function storedFolderRevision(row: RevisionRow): StoredFolderRevision {
  const provenance = storedProvenance(row);
  if (row.kind !== 'folder') {
    throw new Error('Stored folder revision kind is invalid.');
  }
  const common = {
    apiVersion: 'v1' as const,
    kind: 'folder' as const,
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    revisionId: row.revision_id,
    manifest: {
      contentId: row.content_id,
      contentHash: row.content_hash,
      byteCount: parseByteCount(row.byte_count),
    },
    rootName: row.original_file_name,
    totalByteCount: parseNonNegativeByteCount(row.total_byte_count),
    fileCount: row.file_count,
    publisherMetadata: parsePublisherMetadata(row.publisher_metadata),
  };
  return provenance.classification === 'direct-publish'
    ? { ...common, provenance }
    : { ...common, provenance };
}

function isStoredFolderPublish(revision: StoredFolderRevision): revision is StoredFolderPublish {
  return revision.provenance.classification === 'direct-publish';
}

function isStoredFolderRestore(revision: StoredFolderRevision): revision is StoredFolderRestore {
  return revision.provenance.classification === 'restore';
}

function storedFolderEntry(row: {
  path: string;
  kind: 'directory' | 'file';
  media_type: string | null;
  content_id: string | null;
  content_hash: string | null;
  byte_count: string | null;
}): StoredFolderEntry {
  if (row.kind === 'directory') return { path: row.path, kind: 'directory' };
  if (
    row.media_type === null ||
    row.content_id === null ||
    row.content_hash === null ||
    row.byte_count === null
  ) {
    throw new Error('Stored folder file entry is invalid.');
  }
  return {
    path: row.path,
    kind: 'file',
    mediaType: row.media_type,
    content: {
      contentId: row.content_id,
      contentHash: row.content_hash,
      byteCount: parseNonNegativeByteCount(row.byte_count),
    },
  };
}

function isStoredPublish(revision: StoredRevision): revision is StoredPublish {
  return revision.provenance.classification === 'direct-publish';
}

function isStoredRestore(revision: StoredRevision): revision is StoredRestore {
  return revision.provenance.classification === 'restore';
}

function storedPublish(row: RevisionRow): StoredPublish {
  const revision = storedRevision(row);
  if (!isStoredPublish(revision)) {
    throw new Error('Stored publish provenance is invalid.');
  }
  return revision;
}

async function findRevision(
  database: DatabaseExecutor,
  revisionId: string,
): Promise<StoredRevision | undefined> {
  const row = await database
    .selectFrom('shelf_revisions as revision')
    .innerJoin('shelf_artifacts as artifact', (join) =>
      join
        .onRef('artifact.installation_id', '=', 'revision.installation_id')
        .onRef('artifact.workspace_id', '=', 'revision.workspace_id')
        .onRef('artifact.artifact_id', '=', 'revision.artifact_id'),
    )
    .selectAll('revision')
    .where('revision.revision_id', '=', revisionId)
    .where('artifact.deleted_at', 'is', null)
    .executeTakeFirst();
  return row === undefined ? undefined : storedRevision(row);
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
  return {
    fingerprint,
    ...(revision.kind === 'file' ? { result: storedPublish(revision) } : {}),
  };
}

async function findRestoreIdempotency(
  database: DatabaseExecutor,
  namespace: RestoreIdempotencyNamespace,
): Promise<RestoreIdempotencyRecord | undefined> {
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
  const { fingerprint, ...revisionRow } = row;
  const revision =
    revisionRow.kind === 'folder' ? storedFolderRevision(revisionRow) : storedRevision(revisionRow);
  if (
    (revision.kind === 'folder' && !isStoredFolderRestore(revision)) ||
    (revision.kind !== 'folder' && !isStoredRestore(revision))
  ) {
    throw new Error('Stored restore idempotency provenance is invalid.');
  }
  return {
    fingerprint,
    result: revision,
    revisionNumber: parseRevisionNumber(revisionRow.revision_number),
  };
}

async function findFolderIdempotency(
  database: DatabaseExecutor,
  namespace: IdempotencyNamespace,
): Promise<FolderIdempotencyRecord | undefined> {
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
  return {
    fingerprint,
    ...(revision.kind === 'folder' && revision.provenance_classification === 'direct-publish'
      ? { result: storedFolderPublish(revision) }
      : {}),
  };
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
    return existing.fingerprint === input.fingerprint && existing.result !== undefined
      ? { status: 'replayed', result: existing.result }
      : { status: 'conflict' };
  }

  await transaction
    .insertInto('shelf_artifacts')
    .values({
      artifact_id: input.result.artifactId,
      installation_id: input.result.installationId,
      workspace_id: input.result.workspaceId,
      name: initialArtifactNameFromFileName(input.result.originalFileName),
      kind: 'file',
      latest_revision_id: null,
      created_at: sql`transaction_timestamp()`,
      updated_at: sql`transaction_timestamp()`,
      deleted_at: null,
      recoverable_until: null,
      deleted_by_actor_id: null,
      deleted_share_count: null,
    })
    .onConflict((conflict) => conflict.column('artifact_id').doNothing())
    .execute();

  const artifact = await transaction
    .selectFrom('shelf_artifacts')
    .select(['installation_id', 'workspace_id', 'kind', 'deleted_at'])
    .where('artifact_id', '=', input.result.artifactId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    artifact.installation_id !== input.result.installationId ||
    artifact.workspace_id !== input.result.workspaceId ||
    artifact.kind !== 'file' ||
    artifact.deleted_at !== null
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
      kind: 'file',
      revision_number: ordinal.next_revision_number,
      content_id: input.result.content.contentId,
      content_hash: input.result.content.contentHash,
      byte_count: String(input.result.content.byteCount),
      total_byte_count: String(input.result.content.byteCount),
      file_count: 1,
      original_file_name: input.result.originalFileName,
      media_type: input.result.mediaType,
      provenance_classification: input.result.provenance.classification,
      actor_id: input.result.provenance.observed.actorId,
      operation: input.result.provenance.observed.operation,
      publisher_metadata: input.result.publisherMetadata,
      source_revision_id: null,
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

async function commitNewRestore(
  transaction: Transaction<ShelfPostgresSchema>,
  input: CommitRestoreInput,
): Promise<CommitRestoreOutcome> {
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
    const existing = await findRestoreIdempotency(transaction, input.namespace);
    if (existing === undefined) throw new Error('Idempotency conflict resolved without a record.');
    return existing.fingerprint === input.fingerprint
      ? { status: 'replayed', result: existing.result, revisionNumber: existing.revisionNumber }
      : { status: 'conflict' };
  }

  const artifact = await transaction
    .selectFrom('shelf_artifacts')
    .select(['installation_id', 'workspace_id', 'kind', 'deleted_at'])
    .where('artifact_id', '=', input.result.artifactId)
    .forUpdate()
    .executeTakeFirst();
  if (
    artifact === undefined ||
    artifact.installation_id !== input.result.installationId ||
    artifact.workspace_id !== input.result.workspaceId ||
    artifact.kind !== (input.result.kind === 'folder' ? 'folder' : 'file') ||
    artifact.deleted_at !== null
  ) {
    throw new Error('Restore artifact identity is invalid.');
  }

  const source = await transaction
    .selectFrom('shelf_revisions')
    .selectAll()
    .where('installation_id', '=', input.result.installationId)
    .where('workspace_id', '=', input.result.workspaceId)
    .where('artifact_id', '=', input.result.artifactId)
    .where('revision_id', '=', input.result.provenance.source.revisionId)
    .executeTakeFirst();
  if (
    source === undefined ||
    source.kind !== (input.result.kind === 'folder' ? 'folder' : 'file')
  ) {
    throw new Error('Restore source revision is invalid.');
  }

  const ordinal = await transaction
    .selectFrom('shelf_revisions')
    .select(sql<string>`coalesce(max(revision_number), 0) + 1`.as('next_revision_number'))
    .where('artifact_id', '=', input.result.artifactId)
    .executeTakeFirstOrThrow();

  const inserted = await transaction
    .insertInto('shelf_revisions')
    .values({
      revision_id: input.result.revisionId,
      installation_id: input.result.installationId,
      workspace_id: input.result.workspaceId,
      artifact_id: input.result.artifactId,
      kind: source.kind,
      revision_number: ordinal.next_revision_number,
      content_id: source.content_id,
      content_hash: source.content_hash,
      byte_count: source.byte_count,
      total_byte_count: source.total_byte_count,
      file_count: source.file_count,
      original_file_name: source.original_file_name,
      media_type: source.media_type,
      provenance_classification: 'restore',
      actor_id: input.result.provenance.observed.actorId,
      operation: 'revision.restore',
      publisher_metadata: source.publisher_metadata,
      source_revision_id: source.revision_id,
      created_at: sql`transaction_timestamp()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  if (inserted.kind === 'folder') {
    await transaction
      .insertInto('shelf_revision_entries')
      .columns([
        'installation_id',
        'workspace_id',
        'artifact_id',
        'revision_id',
        'path',
        'kind',
        'media_type',
        'content_id',
        'content_hash',
        'byte_count',
      ])
      .expression(
        transaction
          .selectFrom('shelf_revision_entries')
          .select([
            'installation_id',
            'workspace_id',
            'artifact_id',
            sql<string>`${inserted.revision_id}`.as('revision_id'),
            'path',
            'kind',
            'media_type',
            'content_id',
            'content_hash',
            'byte_count',
          ])
          .where('revision_id', '=', source.revision_id),
      )
      .execute();
  }

  await transaction
    .updateTable('shelf_artifacts')
    .set({
      latest_revision_id: inserted.revision_id,
      updated_at: sql`transaction_timestamp()`,
    })
    .where('artifact_id', '=', input.result.artifactId)
    .executeTakeFirstOrThrow();

  const result =
    inserted.kind === 'folder' ? storedFolderRevision(inserted) : storedRevision(inserted);
  if (
    (result.kind === 'folder' && !isStoredFolderRestore(result)) ||
    (result.kind !== 'folder' && !isStoredRestore(result))
  ) {
    throw new Error('Committed restore provenance is invalid.');
  }
  return {
    status: 'committed',
    result,
    revisionNumber: parseRevisionNumber(inserted.revision_number),
  };
}

async function commitNewFolderPublish(
  transaction: Transaction<ShelfPostgresSchema>,
  input: CommitFolderPublishInput,
): Promise<CommitFolderPublishOutcome> {
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
    const existing = await findFolderIdempotency(transaction, input.namespace);
    if (existing === undefined) throw new Error('Idempotency conflict resolved without a record.');
    return existing.fingerprint === input.fingerprint && existing.result !== undefined
      ? { status: 'replayed', result: existing.result }
      : { status: 'conflict' };
  }

  await transaction
    .insertInto('shelf_artifacts')
    .values({
      artifact_id: input.result.artifactId,
      installation_id: input.result.installationId,
      workspace_id: input.result.workspaceId,
      name: initialArtifactNameFromFileName(input.result.rootName),
      kind: 'folder',
      latest_revision_id: null,
      created_at: sql`transaction_timestamp()`,
      updated_at: sql`transaction_timestamp()`,
      deleted_at: null,
      recoverable_until: null,
      deleted_by_actor_id: null,
      deleted_share_count: null,
    })
    .onConflict((conflict) => conflict.column('artifact_id').doNothing())
    .execute();
  const artifact = await transaction
    .selectFrom('shelf_artifacts')
    .select(['installation_id', 'workspace_id', 'kind', 'deleted_at'])
    .where('artifact_id', '=', input.result.artifactId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    artifact.installation_id !== input.result.installationId ||
    artifact.workspace_id !== input.result.workspaceId ||
    artifact.kind !== 'folder' ||
    artifact.deleted_at !== null
  ) {
    throw new Error('Folder artifact identity is invalid.');
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
      kind: 'folder',
      revision_number: ordinal.next_revision_number,
      content_id: input.result.manifest.contentId,
      content_hash: input.result.manifest.contentHash,
      byte_count: String(input.result.manifest.byteCount),
      total_byte_count: String(input.result.totalByteCount),
      file_count: input.result.fileCount,
      original_file_name: input.result.rootName,
      media_type: 'application/vnd.shelf.folder-manifest+json',
      provenance_classification: 'direct-publish',
      actor_id: input.result.provenance.observed.actorId,
      operation: 'file.publish',
      publisher_metadata: input.result.publisherMetadata,
      source_revision_id: null,
      created_at: sql`transaction_timestamp()`,
    })
    .execute();
  if (input.entries.length > 0) {
    await transaction
      .insertInto('shelf_revision_entries')
      .values(
        input.entries.map((entry) => ({
          installation_id: input.result.installationId,
          workspace_id: input.result.workspaceId,
          artifact_id: input.result.artifactId,
          revision_id: input.result.revisionId,
          path: entry.path,
          kind: entry.kind,
          media_type: entry.kind === 'file' ? entry.mediaType : null,
          content_id: entry.kind === 'file' ? entry.content.contentId : null,
          content_hash: entry.kind === 'file' ? entry.content.contentHash : null,
          byte_count: entry.kind === 'file' ? String(entry.content.byteCount) : null,
        })),
      )
      .execute();
  }
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

export class PostgresRevisionRepository
  implements
    RevisionRepository,
    ArtifactCatalogRepository,
    ArtifactLifecycleRepository,
    ArtifactDeletionRepository,
    FolderRevisionRepository,
    RevisionComparisonRepository
{
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  findIdempotency(namespace: IdempotencyNamespace): Promise<IdempotencyRecord | undefined> {
    return findIdempotency(this.#database, namespace);
  }

  findFolderIdempotency(
    namespace: IdempotencyNamespace,
  ): Promise<FolderIdempotencyRecord | undefined> {
    return findFolderIdempotency(this.#database, namespace);
  }

  commitFolderPublish(input: CommitFolderPublishInput): Promise<CommitFolderPublishOutcome> {
    return this.#database
      .transaction()
      .execute((transaction) => commitNewFolderPublish(transaction, input));
  }

  async findFolderRevision(revisionId: string): Promise<StoredFolderRevision | undefined> {
    const row = await this.#database
      .selectFrom('shelf_revisions as revision')
      .innerJoin('shelf_artifacts as artifact', (join) =>
        join
          .onRef('artifact.installation_id', '=', 'revision.installation_id')
          .onRef('artifact.workspace_id', '=', 'revision.workspace_id')
          .onRef('artifact.artifact_id', '=', 'revision.artifact_id'),
      )
      .selectAll('revision')
      .where('revision.revision_id', '=', revisionId)
      .where('revision.kind', '=', 'folder')
      .where('artifact.deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : storedFolderRevision(row);
  }

  async findComparableRevision(revisionId: string) {
    const row = await this.#database
      .selectFrom('shelf_revisions as revision')
      .innerJoin('shelf_artifacts as artifact', (join) =>
        join
          .onRef('artifact.installation_id', '=', 'revision.installation_id')
          .onRef('artifact.workspace_id', '=', 'revision.workspace_id')
          .onRef('artifact.artifact_id', '=', 'revision.artifact_id'),
      )
      .selectAll('revision')
      .where('revision.revision_id', '=', revisionId)
      .where('artifact.deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return row.kind === 'folder'
      ? storedFolderRevision(row)
      : { ...storedRevision(row), kind: 'file' as const };
  }

  async listFolderEntries(request: {
    installationId: string;
    revisionId: string;
    limit: number;
    afterPath?: string;
  }) {
    let query = this.#database
      .selectFrom('shelf_revision_entries as entry')
      .innerJoin('shelf_artifacts as artifact', (join) =>
        join
          .onRef('artifact.installation_id', '=', 'entry.installation_id')
          .onRef('artifact.workspace_id', '=', 'entry.workspace_id')
          .onRef('artifact.artifact_id', '=', 'entry.artifact_id'),
      )
      .selectAll('entry')
      .where('entry.installation_id', '=', request.installationId)
      .where('entry.revision_id', '=', request.revisionId)
      .where('artifact.deleted_at', 'is', null);
    if (request.afterPath !== undefined) query = query.where('entry.path', '>', request.afterPath);
    const rows = await query
      .orderBy('entry.path')
      .limit(request.limit + 1)
      .execute();
    const hasMore = rows.length > request.limit;
    const items = rows.slice(0, request.limit).map(storedFolderEntry);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { nextPath: last.path } : {}),
    };
  }

  async findArtifactIdentity(artifactId: string) {
    const artifact = await this.#database
      .selectFrom('shelf_artifacts')
      .select(['artifact_id', 'installation_id', 'workspace_id', 'kind'])
      .where('artifact_id', '=', artifactId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return artifact === undefined
      ? undefined
      : {
          artifactId: artifact.artifact_id,
          installationId: artifact.installation_id,
          workspaceId: artifact.workspace_id,
          kind: artifact.kind,
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
        'artifact.name as artifact_name',
        'artifact.kind as artifact_kind',
        'artifact.created_at as artifact_created_at',
        'artifact.updated_at as artifact_updated_at',
      ])
      .where('artifact.artifact_id', '=', artifactId)
      .where('artifact.deleted_at', 'is', null)
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
        'artifact.name as artifact_name',
        'artifact.kind as artifact_kind',
        'artifact.created_at as artifact_created_at',
        'artifact.updated_at as artifact_updated_at',
      ])
      .where('artifact.installation_id', '=', request.installationId)
      .where('artifact.workspace_id', '=', request.workspaceId);
    query = query.where('artifact.deleted_at', 'is', null);
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
    order: 'newest' | 'oldest';
    cursorRevisionNumber?: number;
  }) {
    let query = this.#database
      .selectFrom('shelf_revisions as revision')
      .innerJoin('shelf_artifacts as artifact', (join) =>
        join
          .onRef('artifact.installation_id', '=', 'revision.installation_id')
          .onRef('artifact.workspace_id', '=', 'revision.workspace_id')
          .onRef('artifact.artifact_id', '=', 'revision.artifact_id'),
      )
      .selectAll('revision')
      .where('revision.installation_id', '=', request.installationId)
      .where('revision.artifact_id', '=', request.artifactId)
      .where('artifact.deleted_at', 'is', null);
    if (request.cursorRevisionNumber !== undefined) {
      query = query.where(
        'revision.revision_number',
        request.order === 'newest' ? '<' : '>',
        String(request.cursorRevisionNumber),
      );
    }
    const rows = await query
      .orderBy('revision.revision_number', request.order === 'newest' ? 'desc' : 'asc')
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

  async renameArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    name: string;
  }): Promise<StoredArtifact | undefined> {
    const renamed = await this.#database
      .updateTable('shelf_artifacts')
      .set({ name: request.name, updated_at: sql`transaction_timestamp()` })
      .where('installation_id', '=', request.installationId)
      .where('workspace_id', '=', request.workspaceId)
      .where('artifact_id', '=', request.artifactId)
      .where('deleted_at', 'is', null)
      .returning('artifact_id')
      .executeTakeFirst();
    return renamed === undefined ? undefined : this.findArtifact(renamed.artifact_id);
  }

  findRestoreIdempotency(
    namespace: RestoreIdempotencyNamespace,
  ): Promise<RestoreIdempotencyRecord | undefined> {
    return findRestoreIdempotency(this.#database, namespace);
  }

  commitRestore(input: CommitRestoreInput): Promise<CommitRestoreOutcome> {
    return this.#database
      .transaction()
      .execute((transaction) => commitNewRestore(transaction, input));
  }

  findRevision(revisionId: string): Promise<StoredRevision | undefined> {
    return findRevision(this.#database, revisionId);
  }

  findArtifactForDeletion(artifactId: string): Promise<StoredArtifactDeletionState | undefined> {
    return findArtifactDeletionState(this.#database, artifactId);
  }

  deleteArtifact(request: {
    installationId: string;
    workspaceId: string;
    artifactId: string;
    actorId: string;
    deletedAt: string;
    recoverableUntil: string;
  }) {
    return this.#database.transaction().execute(async (transaction) => {
      const artifact = await transaction
        .selectFrom('shelf_artifacts')
        .select(['deleted_at', 'recoverable_until', 'deleted_share_count'])
        .where('installation_id', '=', request.installationId)
        .where('workspace_id', '=', request.workspaceId)
        .where('artifact_id', '=', request.artifactId)
        .forUpdate()
        .executeTakeFirst();
      if (artifact === undefined) return { status: 'not-found' as const };
      if (artifact.deleted_at !== null) {
        if (artifact.recoverable_until === null || artifact.deleted_share_count === null) {
          throw new Error('Stored artifact deletion state is invalid.');
        }
        return {
          status: 'already-deleted' as const,
          deletedAt: artifact.deleted_at.toISOString(),
          recoverableUntil: artifact.recoverable_until.toISOString(),
          revokedShareCount: artifact.deleted_share_count,
        };
      }

      const deletedAt = new Date(request.deletedAt);
      const recoverableUntil = new Date(request.recoverableUntil);
      const revoked = await transaction
        .updateTable('shelf_shares')
        .set({ revoked_at: deletedAt, revoked_by_actor_id: request.actorId })
        .where('installation_id', '=', request.installationId)
        .where('workspace_id', '=', request.workspaceId)
        .where('artifact_id', '=', request.artifactId)
        .where('revoked_at', 'is', null)
        .where((expressions) =>
          expressions.or([
            expressions('expires_at', 'is', null),
            expressions('expires_at', '>', deletedAt),
          ]),
        )
        .executeTakeFirst();
      const revokedShareCount = Number(revoked.numUpdatedRows);
      if (!Number.isSafeInteger(revokedShareCount) || revokedShareCount < 0) {
        throw new Error('Revoked share count is outside the supported integer range.');
      }
      await transaction
        .updateTable('shelf_artifacts')
        .set({
          deleted_at: deletedAt,
          recoverable_until: recoverableUntil,
          deleted_by_actor_id: request.actorId,
          deleted_share_count: revokedShareCount,
        })
        .where('installation_id', '=', request.installationId)
        .where('workspace_id', '=', request.workspaceId)
        .where('artifact_id', '=', request.artifactId)
        .executeTakeFirstOrThrow();
      return {
        status: 'deleted' as const,
        deletedAt: request.deletedAt,
        recoverableUntil: request.recoverableUntil,
        revokedShareCount,
      };
    });
  }

  recoverArtifact(request: {
    namespace: ArtifactRecoveryIdempotencyNamespace;
    fingerprint: string;
    artifactId: string;
    recoveredAt: string;
  }) {
    return this.#database.transaction().execute(async (transaction) => {
      const artifact = await transaction
        .selectFrom('shelf_artifacts')
        .select(['deleted_at', 'recoverable_until'])
        .where('installation_id', '=', request.namespace.installationId)
        .where('workspace_id', '=', request.namespace.workspaceId)
        .where('artifact_id', '=', request.artifactId)
        .forUpdate()
        .executeTakeFirst();
      if (artifact === undefined) {
        return { status: 'not-found' as const };
      }

      const existing = await findRecoveryIdempotency(transaction, request.namespace);
      if (existing !== undefined) {
        return existing.fingerprint === request.fingerprint
          ? { status: 'replayed' as const, artifact: existing.artifact }
          : { status: 'conflict' as const };
      }
      if (artifact.deleted_at === null) return { status: 'not-found' as const };
      if (
        artifact.recoverable_until === null ||
        artifact.recoverable_until.getTime() <= Date.parse(request.recoveredAt)
      ) {
        return { status: 'expired' as const };
      }

      const deletionState = await findArtifactDeletionState(transaction, request.artifactId);
      if (deletionState === undefined || deletionState.deletedAt === null) {
        throw new Error('Deleted artifact could not be read for recovery.');
      }
      const recoveredArtifact = {
        ...deletionState.artifact,
        updatedAt: request.recoveredAt,
      };
      const claim = await transaction
        .insertInto('shelf_artifact_recovery_idempotency')
        .values({
          installation_id: request.namespace.installationId,
          workspace_id: request.namespace.workspaceId,
          actor_id: request.namespace.actorId,
          operation: request.namespace.operation,
          client_key: request.namespace.key,
          fingerprint: request.fingerprint,
          artifact_id: request.artifactId,
          result: recoveredArtifact,
          created_at: sql`transaction_timestamp()`,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['installation_id', 'workspace_id', 'actor_id', 'operation', 'client_key'])
            .doNothing(),
        )
        .returning('artifact_id')
        .executeTakeFirst();
      if (claim === undefined) {
        const concurrent = await findRecoveryIdempotency(transaction, request.namespace);
        if (concurrent === undefined) {
          throw new Error('Artifact recovery idempotency claim disappeared.');
        }
        return concurrent.fingerprint === request.fingerprint
          ? { status: 'replayed' as const, artifact: concurrent.artifact }
          : { status: 'conflict' as const };
      }
      await transaction
        .updateTable('shelf_artifacts')
        .set({
          deleted_at: null,
          recoverable_until: null,
          deleted_by_actor_id: null,
          deleted_share_count: null,
          updated_at: new Date(request.recoveredAt),
        })
        .where('installation_id', '=', request.namespace.installationId)
        .where('workspace_id', '=', request.namespace.workspaceId)
        .where('artifact_id', '=', request.artifactId)
        .executeTakeFirstOrThrow();
      return { status: 'recovered' as const, artifact: recoveredArtifact };
    });
  }
}
