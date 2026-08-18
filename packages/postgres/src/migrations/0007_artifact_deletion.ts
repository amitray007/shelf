import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const artifactDeletionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_artifacts
        add column deleted_at timestamptz,
        add column recoverable_until timestamptz,
        add column deleted_by_actor_id text,
        add column deleted_share_count integer,
        add constraint shelf_artifacts_deletion_state check (
          (
            deleted_at is null
            and recoverable_until is null
            and deleted_by_actor_id is null
            and deleted_share_count is null
          )
          or (
            deleted_at is not null
            and recoverable_until is not null
            and recoverable_until = deleted_at + interval '720 hours'
            and deleted_by_actor_id is not null
            and deleted_share_count is not null
            and deleted_share_count >= 0
          )
        ),
        add constraint shelf_artifacts_deleter_fk
          foreign key (installation_id, deleted_by_actor_id)
          references shelf_actors (installation_id, actor_id)
    `.execute(database);
    await sql`
      create index shelf_artifacts_recovery_idx
      on shelf_artifacts (recoverable_until, artifact_id)
      where deleted_at is not null
    `.execute(database);
    await sql`
      create table shelf_artifact_recovery_idempotency (
        installation_id text not null,
        workspace_id text not null,
        actor_id text not null,
        operation text not null,
        client_key text not null,
        fingerprint text not null,
        artifact_id text not null,
        result jsonb not null,
        created_at timestamptz not null default transaction_timestamp(),
        primary key (installation_id, workspace_id, actor_id, operation, client_key),
        constraint shelf_artifact_recovery_idempotency_identity_lengths check (
          char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(actor_id) between 1 and 128
          and char_length(client_key) between 1 and 128
        ),
        constraint shelf_artifact_recovery_idempotency_operation check (
          operation = 'artifact.recover'
        ),
        constraint shelf_artifact_recovery_idempotency_fingerprint_format check (
          fingerprint ~ '^artifact-recovery-request/v1:sha256:[a-f0-9]{64}$'
        ),
        constraint shelf_artifact_recovery_idempotency_result_object check (
          jsonb_typeof(result) = 'object'
        ),
        constraint shelf_artifact_recovery_idempotency_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_artifact_recovery_idempotency_artifact_fk
          foreign key (installation_id, workspace_id, artifact_id)
          references shelf_artifacts (installation_id, workspace_id, artifact_id)
      )
    `.execute(database);
    await sql`
      create index shelf_artifact_recovery_idempotency_artifact_idx
      on shelf_artifact_recovery_idempotency (installation_id, workspace_id, artifact_id)
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_artifacts where deleted_at is not null)
          or exists (select 1 from shelf_artifact_recovery_idempotency) then
          raise exception 'Cannot remove artifact deletion migration while deletion state exists.';
        end if;
      end
      $$
    `.execute(database);
    await sql`drop table shelf_artifact_recovery_idempotency`.execute(database);
    await sql`drop index shelf_artifacts_recovery_idx`.execute(database);
    await sql`
      alter table shelf_artifacts
        drop constraint shelf_artifacts_deleter_fk,
        drop constraint shelf_artifacts_deletion_state,
        drop column deleted_share_count,
        drop column deleted_by_actor_id,
        drop column recoverable_until,
        drop column deleted_at
    `.execute(database);
  },
};
