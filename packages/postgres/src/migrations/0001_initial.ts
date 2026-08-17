import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const initialMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table shelf_artifacts (
        artifact_id text primary key,
        installation_id text not null,
        workspace_id text not null,
        latest_revision_id text,
        created_at timestamptz not null default transaction_timestamp(),
        updated_at timestamptz not null default transaction_timestamp(),
        constraint shelf_artifacts_identity_lengths check (
          char_length(artifact_id) between 1 and 128
          and char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
        ),
        unique (installation_id, workspace_id, artifact_id)
      )
    `.execute(database);

    await sql`
      create table shelf_revisions (
        revision_id text primary key,
        installation_id text not null,
        workspace_id text not null,
        artifact_id text not null,
        revision_number bigint not null,
        content_id text not null,
        content_hash text not null,
        byte_count bigint not null,
        original_file_name text not null,
        media_type text not null,
        provenance_classification text not null,
        actor_id text not null,
        operation text not null,
        publisher_metadata jsonb not null,
        created_at timestamptz not null default transaction_timestamp(),
        constraint shelf_revisions_artifact_fk
          foreign key (installation_id, workspace_id, artifact_id)
          references shelf_artifacts (installation_id, workspace_id, artifact_id),
        constraint shelf_revisions_identity_lengths check (
          char_length(revision_id) between 1 and 128
          and char_length(content_id) between 1 and 128
          and char_length(actor_id) between 1 and 128
        ),
        constraint shelf_revisions_number_positive check (revision_number > 0),
        constraint shelf_revisions_byte_count_positive check (byte_count > 0),
        constraint shelf_revisions_hash_format check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
        constraint shelf_revisions_provenance check (
          provenance_classification = 'direct-publish' and operation = 'file.publish'
        ),
        unique (artifact_id, revision_number),
        unique (installation_id, workspace_id, revision_id)
      )
    `.execute(database);

    await sql`
      alter table shelf_artifacts
      add constraint shelf_artifacts_latest_revision_fk
      foreign key (installation_id, workspace_id, latest_revision_id)
      references shelf_revisions (installation_id, workspace_id, revision_id)
      deferrable initially deferred
    `.execute(database);

    await sql`
      create table shelf_idempotency (
        installation_id text not null,
        workspace_id text not null,
        actor_id text not null,
        operation text not null,
        client_key text not null,
        fingerprint text not null,
        revision_id text not null,
        created_at timestamptz not null default transaction_timestamp(),
        primary key (installation_id, workspace_id, actor_id, operation, client_key),
        constraint shelf_idempotency_identity_lengths check (
          char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(actor_id) between 1 and 128
          and char_length(operation) between 1 and 128
          and char_length(client_key) between 1 and 128
        ),
        constraint shelf_idempotency_fingerprint_format check (
          fingerprint ~ '^publish-request/v1:sha256:[a-f0-9]{64}$'
        ),
        constraint shelf_idempotency_revision_fk
          foreign key (installation_id, workspace_id, revision_id)
          references shelf_revisions (installation_id, workspace_id, revision_id)
          deferrable initially deferred
      )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`drop table shelf_idempotency`.execute(database);
    await sql`alter table shelf_artifacts drop constraint shelf_artifacts_latest_revision_fk`.execute(
      database,
    );
    await sql`drop table shelf_revisions`.execute(database);
    await sql`drop table shelf_artifacts`.execute(database);
  },
};
