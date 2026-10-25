import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const htmlPreviewSettingsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`create table shelf_html_preview_settings (
      installation_id text primary key,
      trusted_resource_origins jsonb not null,
      constraint shelf_html_preview_settings_origins check (
        jsonb_typeof(trusted_resource_origins) = 'array'
        and jsonb_array_length(trusted_resource_origins) <= 32
      )
    )`.execute(database);
  },
  async down(database: Kysely<unknown>): Promise<void> {
    await sql`drop table shelf_html_preview_settings`.execute(database);
  },
};
