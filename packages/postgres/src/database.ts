import { type Generated, Kysely, PostgresDialect, type Selectable } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

export interface ArtifactTable {
  artifact_id: string;
  installation_id: string;
  workspace_id: string;
  name: string;
  kind: 'file' | 'folder';
  latest_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  recoverable_until: Date | null;
  deleted_by_actor_id: string | null;
  deleted_share_count: number | null;
}

export interface RevisionTable {
  revision_id: string;
  installation_id: string;
  workspace_id: string;
  artifact_id: string;
  kind: 'file' | 'folder';
  revision_number: string;
  content_id: string;
  content_hash: string;
  byte_count: string;
  total_byte_count: string;
  file_count: number;
  original_file_name: string;
  media_type: string;
  provenance_classification: string;
  actor_id: string;
  operation: string;
  publisher_metadata: unknown;
  source_revision_id: string | null;
  created_at: Date;
}

export interface RevisionEntryTable {
  installation_id: string;
  workspace_id: string;
  artifact_id: string;
  revision_id: string;
  path: string;
  kind: 'directory' | 'file';
  media_type: string | null;
  content_id: string | null;
  content_hash: string | null;
  byte_count: string | null;
}

export interface IdempotencyTable {
  installation_id: string;
  workspace_id: string;
  actor_id: string;
  operation: string;
  client_key: string;
  fingerprint: string;
  revision_id: string;
  created_at: Date;
}

export interface ShareTable {
  share_id: string;
  installation_id: string;
  workspace_id: string;
  artifact_id: string;
  visibility: 'unlisted';
  access_type: 'protected' | 'public';
  public_code: string | null;
  target_mode: 'latest' | 'pinned';
  target_revision_id: string | null;
  created_by_actor_id: string;
  created_at: Date;
  expires_at: Date | null;
  max_sessions: number | null;
  sessions_used: string;
  revoked_at: Date | null;
  revoked_by_actor_id: string | null;
}

export interface ShareSessionReceiptTable {
  share_id: string;
  session_id: string;
  established_at: Date;
  receipt_expires_at: Date;
}

export interface ShareIdempotencyTable {
  installation_id: string;
  workspace_id: string;
  actor_id: string;
  operation: 'share.create';
  client_key: string;
  fingerprint: string;
  share_id: string;
  created_at: Date;
}

export interface ArtifactRecoveryIdempotencyTable {
  installation_id: string;
  workspace_id: string;
  actor_id: string;
  operation: 'artifact.recover';
  client_key: string;
  fingerprint: string;
  artifact_id: string;
  result: unknown;
  created_at: Date;
}

export interface ActorTable {
  actor_id: string;
  installation_id: string;
  actor_kind: 'human' | 'service';
  actor_name: string;
  auth_user_id: string | null;
  created_by_actor_id: string | null;
  created_at: Date;
  disabled_at: Date | null;
}

export interface WorkspaceTable {
  installation_id: string;
  workspace_id: string;
  created_by_actor_id: string;
  created_at: Date;
}

export interface ActorGrantTable {
  installation_id: string;
  actor_id: string;
  workspace_id: string;
  action: 'file.publish' | 'revision.read';
  granted_by_actor_id: string;
  granted_at: Date;
}

export interface AccessCredentialTable {
  credential_id: string;
  installation_id: string;
  actor_id: string;
  digest: string;
  created_by_actor_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by_actor_id: string | null;
  last_used_at: Date | null;
}

export interface AuthEventTable {
  event_sequence: Generated<string>;
  event_type:
    | 'human-actor.created'
    | 'access-credential.issued'
    | 'access-credential.rotated'
    | 'access-credential.revoked'
    | 'workspace.created';
  installation_id: string;
  actor_id: string;
  credential_id: string | null;
  performed_by_actor_id: string;
  occurred_at: Date;
}

export interface ShelfPostgresSchema {
  shelf_access_credentials: AccessCredentialTable;
  shelf_actor_grants: ActorGrantTable;
  shelf_actors: ActorTable;
  shelf_artifacts: ArtifactTable;
  shelf_artifact_recovery_idempotency: ArtifactRecoveryIdempotencyTable;
  shelf_auth_events: AuthEventTable;
  shelf_revisions: RevisionTable;
  shelf_revision_entries: RevisionEntryTable;
  shelf_idempotency: IdempotencyTable;
  shelf_shares: ShareTable;
  shelf_share_idempotency: ShareIdempotencyTable;
  shelf_share_session_receipts: ShareSessionReceiptTable;
  shelf_workspaces: WorkspaceTable;
}

export type ShelfPostgresDatabase = Kysely<ShelfPostgresSchema>;
export type RevisionRow = Selectable<RevisionTable>;

export interface PostgresDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  ssl?: PoolConfig['ssl'];
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): ShelfPostgresDatabase {
  if (options.connectionString.length === 0)
    throw new Error('PostgreSQL connectionString is required.');
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...(options.idleTimeoutMillis === undefined
      ? {}
      : { idleTimeoutMillis: options.idleTimeoutMillis }),
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  return new Kysely<ShelfPostgresSchema>({ dialect: new PostgresDialect({ pool }) });
}
