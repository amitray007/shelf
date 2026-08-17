import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const sharesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table shelf_shares (
        share_id text primary key,
        installation_id text not null,
        workspace_id text not null,
        artifact_id text not null,
        visibility text not null,
        target_mode text not null,
        target_revision_id text,
        created_by_actor_id text not null,
        created_at timestamptz not null,
        expires_at timestamptz,
        revoked_at timestamptz,
        revoked_by_actor_id text,
        constraint shelf_shares_id_format check (
          share_id ~ '^shr_[A-Za-z0-9_-]{22}$'
        ),
        constraint shelf_shares_identity_lengths check (
          char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(artifact_id) between 1 and 128
          and char_length(created_by_actor_id) between 1 and 128
        ),
        constraint shelf_shares_visibility check (visibility = 'unlisted'),
        constraint shelf_shares_target check (
          (target_mode = 'latest' and target_revision_id is null)
          or (target_mode = 'pinned' and target_revision_id is not null)
        ),
        constraint shelf_shares_expiry check (
          expires_at is null or expires_at > created_at
        ),
        constraint shelf_shares_revocation check (
          (revoked_at is null and revoked_by_actor_id is null)
          or (
            revoked_at is not null
            and revoked_by_actor_id is not null
            and revoked_at >= created_at
          )
        ),
        constraint shelf_shares_artifact_fk
          foreign key (installation_id, workspace_id, artifact_id)
          references shelf_artifacts (installation_id, workspace_id, artifact_id),
        constraint shelf_shares_target_revision_fk
          foreign key (installation_id, workspace_id, artifact_id, target_revision_id)
          references shelf_revisions (installation_id, workspace_id, artifact_id, revision_id),
        constraint shelf_shares_creator_fk
          foreign key (installation_id, created_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_shares_revoker_fk
          foreign key (installation_id, revoked_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        unique (installation_id, workspace_id, created_by_actor_id, share_id)
      )
    `.execute(database);

    await sql`
      create index shelf_shares_workspace_created_idx
      on shelf_shares (installation_id, workspace_id, created_at desc, share_id)
    `.execute(database);
    await sql`
      create index shelf_shares_artifact_idx
      on shelf_shares (installation_id, workspace_id, artifact_id, created_at desc)
    `.execute(database);
    await sql`
      create index shelf_shares_active_expiry_idx
      on shelf_shares (expires_at)
      where revoked_at is null and expires_at is not null
    `.execute(database);
    await sql`
      create index shelf_shares_target_revision_idx
      on shelf_shares (installation_id, workspace_id, artifact_id, target_revision_id)
      where target_revision_id is not null
    `.execute(database);

    await sql`
      create table shelf_share_idempotency (
        installation_id text not null,
        workspace_id text not null,
        actor_id text not null,
        operation text not null,
        client_key text not null,
        fingerprint text not null,
        share_id text not null,
        created_at timestamptz not null default transaction_timestamp(),
        primary key (installation_id, workspace_id, actor_id, operation, client_key),
        constraint shelf_share_idempotency_identity_lengths check (
          char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(actor_id) between 1 and 128
          and char_length(client_key) between 1 and 128
        ),
        constraint shelf_share_idempotency_operation check (operation = 'share.create'),
        constraint shelf_share_idempotency_fingerprint_format check (
          fingerprint ~ '^share-create-request/v1:sha256:[a-f0-9]{64}$'
        ),
        constraint shelf_share_idempotency_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_share_idempotency_share_fk
          foreign key (installation_id, workspace_id, actor_id, share_id)
          references shelf_shares (
            installation_id, workspace_id, created_by_actor_id, share_id
          )
          deferrable initially deferred
      )
    `.execute(database);
    await sql`
      create index shelf_share_idempotency_share_idx
      on shelf_share_idempotency (installation_id, workspace_id, share_id)
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_shares) then
          raise exception 'Cannot remove shares migration while shares exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`drop table shelf_share_idempotency`.execute(database);
    await sql`drop table shelf_shares`.execute(database);
  },
};
