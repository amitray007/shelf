import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const folderSnapshotsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`alter table shelf_artifacts add column kind text not null default 'file'`.execute(
      database,
    );
    await sql`alter table shelf_artifacts alter column kind drop default`.execute(database);
    await sql`
      alter table shelf_artifacts
      add constraint shelf_artifacts_kind check (kind in ('file', 'folder'))
    `.execute(database);
    await sql`
      alter table shelf_artifacts
      add constraint shelf_artifacts_scoped_kind
      unique (installation_id, workspace_id, artifact_id, kind)
    `.execute(database);

    await sql`alter table shelf_revisions add column kind text not null default 'file'`.execute(
      database,
    );
    await sql`
      alter table shelf_revisions
      add column total_byte_count bigint not null default 0
    `.execute(database);
    await sql`update shelf_revisions set total_byte_count = byte_count`.execute(database);
    await sql`alter table shelf_revisions alter column total_byte_count drop default`.execute(
      database,
    );
    await sql`
      alter table shelf_revisions add column file_count integer not null default 1
    `.execute(database);
    await sql`alter table shelf_revisions alter column file_count drop default`.execute(database);
    await sql`alter table shelf_revisions alter column kind drop default`.execute(database);
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_kind_shape check (
        (
          kind = 'file'
          and total_byte_count = byte_count
          and file_count = 1
        )
        or (
          kind = 'folder'
          and total_byte_count >= 0
          and file_count between 0 and 1000
          and media_type = 'application/vnd.shelf.folder-manifest+json'
        )
      )
    `.execute(database);
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_artifact_kind_fk
      foreign key (installation_id, workspace_id, artifact_id, kind)
      references shelf_artifacts (installation_id, workspace_id, artifact_id, kind)
    `.execute(database);

    await sql`
      create table shelf_revision_entries (
        installation_id text not null,
        workspace_id text not null,
        artifact_id text not null,
        revision_id text not null,
        path text collate "C" not null,
        kind text not null,
        media_type text,
        content_id text,
        content_hash text,
        byte_count bigint,
        primary key (revision_id, path),
        constraint shelf_revision_entries_revision_fk
          foreign key (installation_id, workspace_id, artifact_id, revision_id)
          references shelf_revisions (installation_id, workspace_id, artifact_id, revision_id)
          on delete cascade,
        constraint shelf_revision_entries_path check (
          octet_length(path) between 1 and 1024
          and path !~ '[[:cntrl:]]'
          and path !~ '(^/|\\|//|(^|/)\\.{1,2}(/|$))'
        ),
        constraint shelf_revision_entries_kind_shape check (
          (
            kind = 'directory'
            and media_type is null
            and content_id is null
            and content_hash is null
            and byte_count is null
          )
          or (
            kind = 'file'
            and media_type is not null
            and content_id is not null
            and char_length(content_id) between 1 and 128
            and content_hash ~ '^sha256:[a-f0-9]{64}$'
            and byte_count >= 0
          )
        )
      )
    `.execute(database);
    await sql`
      create index shelf_revision_entries_tree
      on shelf_revision_entries (installation_id, revision_id, path)
    `.execute(database);

    await sql`
      alter table shelf_idempotency
      drop constraint shelf_idempotency_fingerprint_format
    `.execute(database);
    await sql`
      alter table shelf_idempotency
      add constraint shelf_idempotency_fingerprint_format check (
        fingerprint ~ '^(publish-request|restore-request|folder-publish-request)/v1:sha256:[a-f0-9]{64}$'
      )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_revisions where kind = 'folder') then
          raise exception 'Cannot remove folder snapshots migration while folder revisions exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`
      alter table shelf_idempotency drop constraint shelf_idempotency_fingerprint_format
    `.execute(database);
    await sql`
      alter table shelf_idempotency
      add constraint shelf_idempotency_fingerprint_format check (
        fingerprint ~ '^(publish-request|restore-request)/v1:sha256:[a-f0-9]{64}$'
      )
    `.execute(database);
    await sql`drop table shelf_revision_entries`.execute(database);
    await sql`
      alter table shelf_revisions drop constraint shelf_revisions_artifact_kind_fk
    `.execute(database);
    await sql`alter table shelf_revisions drop constraint shelf_revisions_kind_shape`.execute(
      database,
    );
    await sql`alter table shelf_revisions drop column file_count`.execute(database);
    await sql`alter table shelf_revisions drop column total_byte_count`.execute(database);
    await sql`alter table shelf_revisions drop column kind`.execute(database);
    await sql`alter table shelf_artifacts drop constraint shelf_artifacts_scoped_kind`.execute(
      database,
    );
    await sql`alter table shelf_artifacts drop constraint shelf_artifacts_kind`.execute(database);
    await sql`alter table shelf_artifacts drop column kind`.execute(database);
  },
};
