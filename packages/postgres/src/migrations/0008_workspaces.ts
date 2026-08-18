import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const workspacesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table shelf_workspaces (
        installation_id text not null,
        workspace_id text not null,
        created_by_actor_id text not null,
        created_at timestamptz not null,
        primary key (installation_id, workspace_id),
        constraint shelf_workspaces_creator_fk
          foreign key (installation_id, created_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_workspaces_identity_lengths check (
          char_length(workspace_id) between 1 and 128
        )
      )
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
          'workspace.created'
        )
      )
    `.execute(database);

    await sql`
      insert into shelf_workspaces (
        installation_id,
        workspace_id,
        created_by_actor_id,
        created_at
      )
      select distinct on (grant_row.installation_id, grant_row.workspace_id)
        grant_row.installation_id,
        grant_row.workspace_id,
        coalesce(owner.actor_id, grant_row.granted_by_actor_id),
        grant_row.granted_at
      from shelf_actor_grants as grant_row
      left join shelf_actors as owner
        on owner.installation_id = grant_row.installation_id
        and owner.actor_kind = 'human'
        and owner.disabled_at is null
      order by grant_row.installation_id, grant_row.workspace_id, grant_row.granted_at
      on conflict (installation_id, workspace_id) do nothing
    `.execute(database);
  },
};
