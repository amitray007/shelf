import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const workspaceDeletionMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_workspaces
        add column deleted_at timestamptz,
        add column deleted_by_actor_id text,
        add constraint shelf_workspaces_deletion_state check (
          (deleted_at is null and deleted_by_actor_id is null)
          or (deleted_at is not null and deleted_by_actor_id is not null)
        ),
        add constraint shelf_workspaces_deleter_fk
          foreign key (installation_id, deleted_by_actor_id)
          references shelf_actors (installation_id, actor_id)
    `.execute(database);

    await sql`
      alter table shelf_auth_events
      drop constraint shelf_auth_events_type
    `.execute(database);
    await sql`
      alter table shelf_auth_events
      add constraint shelf_auth_events_type check (
        event_type in (
          'human-actor.created',
          'access-credential.issued',
          'access-credential.rotated',
          'access-credential.revoked',
          'workspace.created',
          'workspace.deleted'
        )
      )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (select 1 from shelf_workspaces where deleted_at is not null) then
          raise exception 'Cannot remove workspace deletion migration while deleted workspaces exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`delete from shelf_auth_events where event_type = 'workspace.deleted'`.execute(
      database,
    );
    await sql`
      alter table shelf_auth_events
      drop constraint shelf_auth_events_type
    `.execute(database);
    await sql`
      alter table shelf_auth_events
      add constraint shelf_auth_events_type check (
        event_type in (
          'human-actor.created',
          'access-credential.issued',
          'access-credential.rotated',
          'access-credential.revoked',
          'workspace.created'
        )
      )
    `.execute(database);
    await sql`
      alter table shelf_workspaces
        drop constraint shelf_workspaces_deleter_fk,
        drop constraint shelf_workspaces_deletion_state,
        drop column deleted_by_actor_id,
        drop column deleted_at
    `.execute(database);
  },
};
