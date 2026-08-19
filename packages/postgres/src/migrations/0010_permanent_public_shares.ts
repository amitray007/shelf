import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const permanentPublicSharesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        drop constraint shelf_shares_access_policy,
        add constraint shelf_shares_access_policy check (
          (
            access_type = 'protected'
            and public_code is null
          )
          or (
            access_type = 'public'
            and public_code is not null
            and max_sessions is null
            and sessions_used = 0
          )
        )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (
          select 1 from shelf_shares
          where access_type = 'public' and expires_at is null
        ) then
          raise exception 'Cannot require Public expiry while permanent Public shares exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`
      alter table shelf_shares
        drop constraint shelf_shares_access_policy,
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
  },
};
