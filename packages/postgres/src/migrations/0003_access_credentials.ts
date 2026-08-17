import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const accessCredentialsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table shelf_actors (
        actor_id text primary key,
        installation_id text not null,
        actor_kind text not null,
        actor_name text not null,
        auth_user_id text unique,
        created_by_actor_id text,
        created_at timestamptz not null,
        disabled_at timestamptz,
        constraint shelf_actors_kind check (actor_kind in ('human', 'service')),
        constraint shelf_actors_identity_lengths check (
          char_length(actor_id) between 1 and 128
          and char_length(installation_id) between 1 and 128
          and char_length(actor_name) between 1 and 128
        ),
        constraint shelf_actors_human_identity check (
          (actor_kind = 'human' and auth_user_id is not null)
          or (actor_kind = 'service' and auth_user_id is null)
        ),
        unique (installation_id, actor_id)
      )
    `.execute(database);

    await sql`
      alter table shelf_actors
      add constraint shelf_actors_creator_fk
      foreign key (installation_id, created_by_actor_id)
      references shelf_actors (installation_id, actor_id)
      deferrable initially deferred
    `.execute(database);

    await sql`
      create table shelf_actor_grants (
        installation_id text not null,
        actor_id text not null,
        workspace_id text not null,
        action text not null,
        granted_by_actor_id text not null,
        granted_at timestamptz not null,
        primary key (installation_id, actor_id, workspace_id, action),
        constraint shelf_actor_grants_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_actor_grants_granter_fk
          foreign key (installation_id, granted_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_actor_grants_action check (action in ('file.publish', 'revision.read')),
        constraint shelf_actor_grants_identity_lengths check (
          char_length(workspace_id) between 1 and 128
        )
      )
    `.execute(database);

    await sql`
      create table shelf_access_credentials (
        credential_id text primary key,
        installation_id text not null,
        actor_id text not null,
        digest text not null unique,
        created_by_actor_id text not null,
        created_at timestamptz not null,
        expires_at timestamptz,
        revoked_at timestamptz,
        revoked_by_actor_id text,
        last_used_at timestamptz,
        constraint shelf_access_credentials_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_access_credentials_creator_fk
          foreign key (installation_id, created_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_access_credentials_revoker_fk
          foreign key (installation_id, revoked_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_access_credentials_id_format check (
          credential_id ~ '^crd_[A-Za-z0-9_-]{22}$'
        ),
        constraint shelf_access_credentials_digest_format check (
          digest ~ '^sha256:[a-f0-9]{64}$'
        ),
        constraint shelf_access_credentials_revocation check (
          (revoked_at is null and revoked_by_actor_id is null)
          or (revoked_at is not null and revoked_by_actor_id is not null)
        )
      )
    `.execute(database);

    await sql`
      create table shelf_auth_events (
        event_sequence bigint generated always as identity primary key,
        event_type text not null,
        installation_id text not null,
        actor_id text not null,
        credential_id text references shelf_access_credentials (credential_id),
        performed_by_actor_id text not null,
        occurred_at timestamptz not null,
        constraint shelf_auth_events_actor_fk
          foreign key (installation_id, actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_auth_events_performer_fk
          foreign key (installation_id, performed_by_actor_id)
          references shelf_actors (installation_id, actor_id),
        constraint shelf_auth_events_type check (
          event_type in (
            'human-actor.created',
            'access-credential.issued',
            'access-credential.rotated',
            'access-credential.revoked'
          )
        )
      )
    `.execute(database);

    await sql`create index shelf_actor_grants_lookup_idx on shelf_actor_grants (actor_id, workspace_id, action)`.execute(
      database,
    );
    await sql`
      create unique index shelf_actors_one_human_owner_idx
      on shelf_actors (installation_id)
      where actor_kind = 'human'
    `.execute(database);
    await sql`create index shelf_access_credentials_actor_idx on shelf_access_credentials (actor_id, created_at)`.execute(
      database,
    );
    await sql`create index shelf_auth_events_installation_idx on shelf_auth_events (installation_id, event_sequence)`.execute(
      database,
    );
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`drop table shelf_auth_events`.execute(database);
    await sql`drop table shelf_access_credentials`.execute(database);
    await sql`drop table shelf_actor_grants`.execute(database);
    await sql`alter table shelf_actors drop constraint shelf_actors_creator_fk`.execute(database);
    await sql`drop table shelf_actors`.execute(database);
  },
};
