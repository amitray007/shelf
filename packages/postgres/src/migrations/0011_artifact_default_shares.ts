import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const artifactDefaultSharesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        add column is_default boolean not null default false
    `.execute(database);
    await sql`
      create unique index shelf_shares_active_default_unique_idx
        on shelf_shares (installation_id, workspace_id, artifact_id, access_type)
        where is_default and revoked_at is null
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`drop index shelf_shares_active_default_unique_idx`.execute(database);
    await sql`alter table shelf_shares drop column is_default`.execute(database);
  },
};
