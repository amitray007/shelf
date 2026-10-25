import type { HtmlPreviewSettingsRepository } from '@shelf/core';
import { sql } from 'kysely';
import type { ShelfPostgresDatabase } from './database.js';

export class PostgresHtmlPreviewSettingsRepository implements HtmlPreviewSettingsRepository {
  readonly #database: ShelfPostgresDatabase;
  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  async findTrustedResourceOrigins(installationId: string): Promise<unknown | undefined> {
    const row = await this.#database
      .selectFrom('shelf_html_preview_settings')
      .select('trusted_resource_origins')
      .where('installation_id', '=', installationId)
      .executeTakeFirst();
    return row?.trusted_resource_origins;
  }

  async saveTrustedResourceOrigins(
    installationId: string,
    origins: readonly string[],
  ): Promise<void> {
    const values = {
      installation_id: installationId,
      trusted_resource_origins: sql`${JSON.stringify(origins)}::jsonb`,
    };
    await this.#database
      .insertInto('shelf_html_preview_settings')
      .values(values)
      .onConflict((conflict) =>
        conflict
          .column('installation_id')
          .doUpdateSet({ trusted_resource_origins: values.trusted_resource_origins }),
      )
      .execute();
  }
}
