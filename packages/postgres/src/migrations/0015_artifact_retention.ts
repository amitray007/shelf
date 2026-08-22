import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const artifactRetentionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_artifacts
        drop constraint shelf_artifacts_deletion_state,
        add column retention_mode text not null default 'automatic',
        add column auto_trash_at timestamptz,
        add column deletion_reason text,
        add constraint shelf_artifacts_retention_mode check (
          retention_mode in ('automatic', 'keep')
        ),
        add constraint shelf_artifacts_retention_schedule check (
          retention_mode = 'automatic' or auto_trash_at is null
        ),
        add constraint shelf_artifacts_deletion_reason check (
          deletion_reason is null or deletion_reason in ('manual', 'retention')
        ),
        add constraint shelf_artifacts_deletion_state check (
          (
            deleted_at is null
            and recoverable_until is null
            and deleted_by_actor_id is null
            and deleted_share_count is null
            and deletion_reason is null
          )
          or (
            deleted_at is not null
            and recoverable_until is not null
            and recoverable_until = deleted_at + interval '720 hours'
            and deleted_by_actor_id is not null
            and deleted_share_count is not null
            and deleted_share_count >= 0
            and deletion_reason is not null
            and auto_trash_at is null
          )
        ) not valid
    `.execute(database);
    await sql`
      update shelf_artifacts
      set
        auto_trash_at = case
          when deleted_at is null then transaction_timestamp() + interval '30 days'
          else null
        end,
        deletion_reason = case when deleted_at is null then null else 'manual' end
    `.execute(database);
    await sql`set constraints all immediate`.execute(database);
    await sql`
      alter table shelf_artifacts
        validate constraint shelf_artifacts_deletion_state
    `.execute(database);
    await sql`
      create index shelf_artifacts_auto_trash_idx
      on shelf_artifacts (auto_trash_at, artifact_id)
      where deleted_at is null and retention_mode = 'automatic' and auto_trash_at is not null
    `.execute(database);

    await sql`
      alter table shelf_shares
        add column retention_role text not null default 'custom',
        add constraint shelf_shares_retention_role check (
          retention_role in ('default', 'custom', 'recovery-lease')
        )
    `.execute(database);
    await sql`
      update shelf_shares
      set retention_role = case when is_default then 'default' else 'custom' end
    `.execute(database);
    await sql`
      update shelf_artifacts as artifact
      set auto_trash_at = case
        when artifact.deleted_at is not null then null
        when exists (
          select 1
          from shelf_shares as share
          where share.installation_id = artifact.installation_id
            and share.workspace_id = artifact.workspace_id
            and share.artifact_id = artifact.artifact_id
            and share.retention_role = 'custom'
            and share.revoked_at is null
            and share.expires_at is null
            and (share.max_sessions is null or share.sessions_used < share.max_sessions)
        ) then null
        else greatest(
          transaction_timestamp() + interval '30 days',
          coalesce((
            select max(share.expires_at + interval '30 days')
            from shelf_shares as share
            where share.installation_id = artifact.installation_id
              and share.workspace_id = artifact.workspace_id
              and share.artifact_id = artifact.artifact_id
              and share.retention_role = 'custom'
              and share.revoked_at is null
              and share.expires_at > transaction_timestamp()
              and (share.max_sessions is null or share.sessions_used < share.max_sessions)
          ), transaction_timestamp() + interval '30 days')
        )
      end
    `.execute(database);
    await sql`
      alter table shelf_shares
        add constraint shelf_shares_retention_default_consistency check (
          (is_default and retention_role = 'default')
          or (not is_default and retention_role <> 'default')
        )
    `.execute(database);
    await sql`
      create index shelf_shares_retention_active_idx
      on shelf_shares (
        installation_id,
        workspace_id,
        artifact_id,
        expires_at,
        share_id
      )
      where retention_role = 'custom' and revoked_at is null
    `.execute(database);

    await sql`
      create table shelf_content_purge_queue (
        content_id text primary key,
        artifact_id text not null,
        queued_at timestamptz not null,
        attempts integer not null default 0,
        last_attempt_at timestamptz,
        constraint shelf_content_purge_queue_identity check (
          char_length(content_id) between 1 and 128
          and char_length(artifact_id) between 1 and 128
        ),
        constraint shelf_content_purge_queue_attempts check (attempts >= 0)
      )
    `.execute(database);
    await sql`
      create index shelf_content_purge_queue_order_idx
      on shelf_content_purge_queue (queued_at, content_id)
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_content_purge_queue)
          or exists (select 1 from shelf_shares where retention_role = 'recovery-lease')
          or exists (select 1 from shelf_artifacts where deletion_reason = 'retention') then
          raise exception 'Cannot remove artifact retention while retention state exists.';
        end if;
      end
      $$
    `.execute(database);
    await sql`drop table shelf_content_purge_queue`.execute(database);
    await sql`drop index shelf_shares_retention_active_idx`.execute(database);
    await sql`
      alter table shelf_shares
        drop constraint shelf_shares_retention_default_consistency,
        drop constraint shelf_shares_retention_role,
        drop column retention_role
    `.execute(database);
    await sql`drop index shelf_artifacts_auto_trash_idx`.execute(database);
    await sql`
      alter table shelf_artifacts
        drop constraint shelf_artifacts_deletion_state,
        drop constraint shelf_artifacts_deletion_reason,
        drop constraint shelf_artifacts_retention_schedule,
        drop constraint shelf_artifacts_retention_mode,
        drop column deletion_reason,
        drop column auto_trash_at,
        drop column retention_mode,
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
        )
    `.execute(database);
  },
};
