import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const commentsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        add column comment_policy text not null default 'off',
        add constraint shelf_shares_comment_policy check (comment_policy in ('off', 'private', 'shared'))
    `.execute(database);
    await sql`
      create unique index shelf_shares_comment_scope_unique_idx
        on shelf_shares (installation_id, workspace_id, share_id)
    `.execute(database);
    await sql`
      create unique index shelf_shares_comment_artifact_scope_unique_idx
        on shelf_shares (installation_id, workspace_id, artifact_id, share_id)
    `.execute(database);
    await sql`
      create table shelf_comment_visitors (
        installation_id text not null,
        visitor_key text not null,
        display_name text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        primary key (installation_id, visitor_key),
        constraint shelf_comment_visitors_identity check (
          char_length(installation_id) between 1 and 128
          and char_length(visitor_key) between 16 and 512
          and char_length(display_name) between 1 and 128
        )
      )
    `.execute(database);
    await sql`
      create table shelf_comment_threads (
        thread_id text primary key,
        installation_id text not null,
        workspace_id text not null,
        artifact_id text not null,
        share_id text not null,
        revision_id text not null,
        visibility text not null,
        anchor_kind text not null,
        anchor_path text,
        anchor_start_line integer,
        anchor_end_line integer,
        anchor_quoted_text text,
        anchor_content_hash text,
        anchor_status text not null default 'exact',
        starter_visitor_key text,
        resolved_at timestamptz,
        resolved_by_actor_id text,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint shelf_comment_threads_identity check (
          char_length(thread_id) between 1 and 128
          and char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(artifact_id) between 1 and 128
          and char_length(share_id) between 1 and 128
          and char_length(revision_id) between 1 and 128
        ),
        constraint shelf_comment_threads_visibility check (visibility in ('private', 'shared')),
        constraint shelf_comment_threads_anchor_kind check (anchor_kind in ('file', 'range')),
        constraint shelf_comment_threads_anchor_status check (anchor_status in ('exact', 'outdated')),
        constraint shelf_comment_threads_anchor_lines check (
          (anchor_kind = 'file' and anchor_start_line is null and anchor_end_line is null)
          or (anchor_kind = 'range' and anchor_start_line is not null and anchor_end_line is not null
              and anchor_start_line >= 1 and anchor_end_line >= anchor_start_line)
        ),
        constraint shelf_comment_threads_share_fk
          foreign key (installation_id, workspace_id, artifact_id, share_id)
          references shelf_shares (installation_id, workspace_id, artifact_id, share_id),
        constraint shelf_comment_threads_revision_fk
          foreign key (installation_id, workspace_id, artifact_id, revision_id)
          references shelf_revisions (installation_id, workspace_id, artifact_id, revision_id),
        constraint shelf_comment_threads_visitor_fk
          foreign key (installation_id, starter_visitor_key)
          references shelf_comment_visitors (installation_id, visitor_key),
        constraint shelf_comment_threads_resolver_fk
          foreign key (installation_id, resolved_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        unique (installation_id, workspace_id, thread_id)
      )
    `.execute(database);
    await sql`
      create index shelf_comment_threads_share_idx
        on shelf_comment_threads (installation_id, workspace_id, share_id, updated_at desc, thread_id desc)
    `.execute(database);
    await sql`
      create index shelf_comment_threads_artifact_idx
        on shelf_comment_threads (installation_id, workspace_id, artifact_id, updated_at desc, thread_id desc)
    `.execute(database);
    await sql`
      create table shelf_comment_posts (
        post_id text primary key,
        thread_id text not null,
        installation_id text not null,
        workspace_id text not null,
        author_kind text not null,
        visitor_key text,
        actor_id text,
        display_name text,
        body text not null,
        created_at timestamptz not null,
        edited_at timestamptz,
        deleted_at timestamptz,
        hidden_at timestamptz,
        abuse_ip_hash text,
        abuse_browser text,
        abuse_operating_system text,
        abuse_expires_at timestamptz,
        constraint shelf_comment_posts_identity check (
          char_length(post_id) between 1 and 128
          and char_length(thread_id) between 1 and 128
          and char_length(installation_id) between 1 and 128
          and char_length(workspace_id) between 1 and 128
          and char_length(body) between 1 and 20000
        ),
        constraint shelf_comment_posts_author check (
          (author_kind = 'visitor' and visitor_key is not null and actor_id is null and display_name is not null)
          or (author_kind = 'actor' and visitor_key is null and actor_id is not null and display_name is null)
        ),
        constraint shelf_comment_posts_abuse_retention check (
          abuse_expires_at is null
          or (abuse_expires_at > created_at and abuse_expires_at <= created_at + interval '30 days')
        ),
        constraint shelf_comment_posts_thread_fk
          foreign key (installation_id, workspace_id, thread_id)
          references shelf_comment_threads (installation_id, workspace_id, thread_id),
        constraint shelf_comment_posts_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id)
      )
    `.execute(database);
    await sql`
      create index shelf_comment_posts_thread_idx
        on shelf_comment_posts (installation_id, workspace_id, thread_id, created_at)
    `.execute(database);
    await sql`
      create index shelf_comment_posts_abuse_expiry_idx
        on shelf_comment_posts (abuse_expires_at)
        where abuse_expires_at is not null
    `.execute(database);
    await sql`
      create index shelf_comment_posts_visitor_idx
        on shelf_comment_posts (installation_id, visitor_key)
        where visitor_key is not null
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_comment_posts)
        or exists (select 1 from shelf_comment_threads)
        or exists (select 1 from shelf_comment_visitors)
        or exists (select 1 from shelf_shares where comment_policy <> 'off')
        then raise exception 'Cannot remove comments migration while comment state exists.';
        end if;
      end
      $$
    `.execute(database);
    await sql`drop index shelf_comment_posts_visitor_idx`.execute(database);
    await sql`drop index shelf_comment_threads_artifact_idx`.execute(database);
    await sql`drop table shelf_comment_posts`.execute(database);
    await sql`drop table shelf_comment_threads`.execute(database);
    await sql`drop table shelf_comment_visitors`.execute(database);
    await sql`drop index shelf_shares_comment_artifact_scope_unique_idx`.execute(database);
    await sql`drop index shelf_shares_comment_scope_unique_idx`.execute(database);
    await sql`alter table shelf_shares drop constraint shelf_shares_comment_policy, drop column comment_policy`.execute(
      database,
    );
  },
};
