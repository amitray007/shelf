import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const shareRevisionAccessMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        add column revision_access text not null default 'target-only',
        add column history_from_revision_number bigint,
        add constraint shelf_shares_revision_access check (
          (
            revision_access = 'target-only'
            and history_from_revision_number is null
          )
          or (
            revision_access = 'shared-history'
            and target_mode = 'latest'
            and history_from_revision_number is not null
            and history_from_revision_number > 0
          )
        )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`
      do $$
      begin
        if exists (
          select 1 from shelf_shares where revision_access = 'shared-history'
        ) then
          raise exception 'Cannot remove share revision access while history-enabled shares exist.';
        end if;
      end
      $$
    `.execute(database);
    await sql`
      alter table shelf_shares
        drop constraint shelf_shares_revision_access,
        drop column history_from_revision_number,
        drop column revision_access
    `.execute(database);
  },
};
