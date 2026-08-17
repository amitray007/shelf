import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const artifactLifecycleMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`alter table shelf_artifacts add column name text`.execute(database);
    await sql`
      update shelf_artifacts as artifact
      set name = case
        when btrim(regexp_replace(revision.original_file_name, '[[:cntrl:]]', '', 'g')) = ''
          then 'Untitled artifact'
        else left(
          btrim(regexp_replace(revision.original_file_name, '[[:cntrl:]]', '', 'g')),
          255
        )
      end
      from shelf_revisions as revision
      where revision.installation_id = artifact.installation_id
        and revision.workspace_id = artifact.workspace_id
        and revision.artifact_id = artifact.artifact_id
        and revision.revision_number = 1
    `.execute(database);
    await sql`alter table shelf_artifacts alter column name set not null`.execute(database);
    await sql`
      alter table shelf_artifacts
      add constraint shelf_artifacts_name check (
        char_length(name) between 1 and 255
        and name !~ '[[:cntrl:]]'
        and name !~ '^[[:space:]]*$'
      )
    `.execute(database);

    await sql`alter table shelf_revisions add column source_revision_id text`.execute(database);
    await sql`
      alter table shelf_revisions
      drop constraint shelf_revisions_provenance
    `.execute(database);
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_provenance check (
        (
          provenance_classification = 'direct-publish'
          and operation = 'file.publish'
          and source_revision_id is null
        )
        or (
          provenance_classification = 'restore'
          and operation = 'revision.restore'
          and source_revision_id is not null
        )
      )
    `.execute(database);
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_scoped_identity
      unique (installation_id, workspace_id, artifact_id, revision_id)
    `.execute(database);
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_restore_source_fk
      foreign key (installation_id, workspace_id, artifact_id, source_revision_id)
      references shelf_revisions (installation_id, workspace_id, artifact_id, revision_id)
      deferrable initially deferred
    `.execute(database);

    await sql`
      alter table shelf_idempotency
      drop constraint shelf_idempotency_fingerprint_format
    `.execute(database);
    await sql`
      alter table shelf_idempotency
      add constraint shelf_idempotency_fingerprint_format check (
        fingerprint ~ '^(publish-request|restore-request)/v1:sha256:[a-f0-9]{64}$'
      )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (
          select 1 from shelf_revisions where provenance_classification = 'restore'
        ) then
          raise exception 'Cannot remove artifact lifecycle migration while restore revisions exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`
      alter table shelf_idempotency
      drop constraint shelf_idempotency_fingerprint_format
    `.execute(database);
    await sql`
      alter table shelf_idempotency
      add constraint shelf_idempotency_fingerprint_format check (
        fingerprint ~ '^publish-request/v1:sha256:[a-f0-9]{64}$'
      )
    `.execute(database);
    await sql`
      alter table shelf_revisions drop constraint shelf_revisions_restore_source_fk
    `.execute(database);
    await sql`
      alter table shelf_revisions drop constraint shelf_revisions_scoped_identity
    `.execute(database);
    await sql`alter table shelf_revisions drop constraint shelf_revisions_provenance`.execute(
      database,
    );
    await sql`
      alter table shelf_revisions
      add constraint shelf_revisions_provenance check (
        provenance_classification = 'direct-publish' and operation = 'file.publish'
      )
    `.execute(database);
    await sql`alter table shelf_revisions drop column source_revision_id`.execute(database);
    await sql`alter table shelf_artifacts drop constraint shelf_artifacts_name`.execute(database);
    await sql`alter table shelf_artifacts drop column name`.execute(database);
  },
};
