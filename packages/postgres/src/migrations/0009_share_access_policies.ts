import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const shareAccessPoliciesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        add column access_type text not null default 'protected',
        add column public_code text,
        add column max_sessions integer,
        add column sessions_used bigint not null default 0,
        add constraint shelf_shares_access_type check (
          access_type in ('protected', 'public')
        ),
        add constraint shelf_shares_public_code_format check (
          public_code is null or public_code ~ '^[A-Za-z0-9_-]{12}$'
        ),
        add constraint shelf_shares_session_policy check (
          max_sessions is null or max_sessions between 1 and 1000000
        ),
        add constraint shelf_shares_sessions_used check (
          sessions_used >= 0 and (max_sessions is null or sessions_used <= max_sessions)
        ),
        add constraint shelf_shares_access_policy check (
          (
            access_type = 'protected'
            and public_code is null
          )
          or (
            access_type = 'public'
            and public_code is not null
            and expires_at is not null
            and max_sessions is null
            and sessions_used = 0
          )
        )
    `.execute(database);

    await sql`
      create unique index shelf_shares_public_code_unique_idx
      on shelf_shares (public_code)
      where public_code is not null
    `.execute(database);

    await sql`
      alter table shelf_share_idempotency
        drop constraint shelf_share_idempotency_fingerprint_format,
        add constraint shelf_share_idempotency_fingerprint_format check (
          fingerprint ~ '^share-create-request/v[12]:sha256:[a-f0-9]{64}$'
        )
    `.execute(database);

    await sql`
      create table shelf_share_session_receipts (
        share_id text not null,
        session_id text not null,
        established_at timestamptz not null,
        receipt_expires_at timestamptz not null,
        primary key (share_id, session_id),
        constraint shelf_share_session_receipts_session_id_format check (
          session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        constraint shelf_share_session_receipts_expiry check (
          receipt_expires_at > established_at
        ),
        constraint shelf_share_session_receipts_share_fk
          foreign key (share_id) references shelf_shares (share_id) on delete cascade
      )
    `.execute(database);
    await sql`
      create index shelf_share_session_receipts_expiry_idx
      on shelf_share_session_receipts (share_id, receipt_expires_at)
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (
          select 1 from shelf_shares
          where access_type <> 'protected'
             or public_code is not null
             or max_sessions is not null
             or sessions_used <> 0
        )
        or exists (select 1 from shelf_share_session_receipts)
        or exists (
          select 1 from shelf_share_idempotency
          where fingerprint like 'share-create-request/v2:%'
        ) then
          raise exception 'Cannot remove share access policies while policy state exists.';
        end if;
      end
      $$
    `.execute(database);

    await sql`drop table shelf_share_session_receipts`.execute(database);
    await sql`drop index shelf_shares_public_code_unique_idx`.execute(database);
    await sql`
      alter table shelf_share_idempotency
        drop constraint shelf_share_idempotency_fingerprint_format,
        add constraint shelf_share_idempotency_fingerprint_format check (
          fingerprint ~ '^share-create-request/v1:sha256:[a-f0-9]{64}$'
        )
    `.execute(database);
    await sql`
      alter table shelf_shares
        drop constraint shelf_shares_access_policy,
        drop constraint shelf_shares_sessions_used,
        drop constraint shelf_shares_session_policy,
        drop constraint shelf_shares_public_code_format,
        drop constraint shelf_shares_access_type,
        drop column sessions_used,
        drop column max_sessions,
        drop column public_code,
        drop column access_type
    `.execute(database);
  },
};
