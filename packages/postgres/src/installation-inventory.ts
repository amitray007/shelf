import { sql } from 'kysely';

import type { ShelfPostgresDatabase } from './database.js';

export interface InstallationInventory {
  listInstallationIds(): Promise<string[]>;
}

export class PostgresInstallationInventory implements InstallationInventory {
  readonly #database: ShelfPostgresDatabase;

  constructor(database: ShelfPostgresDatabase) {
    this.#database = database;
  }

  async listInstallationIds(): Promise<string[]> {
    const result = await sql<{ installation_id: string }>`
      select distinct installation_id
      from (
        select installation_id from shelf_artifacts
        union all select installation_id from shelf_revisions
        union all select installation_id from shelf_idempotency
        union all select installation_id from shelf_actors
        union all select installation_id from shelf_actor_grants
        union all select installation_id from shelf_access_credentials
        union all select installation_id from shelf_auth_events
      ) installations
      order by installation_id
    `.execute(this.#database);
    return result.rows.map((row) => row.installation_id);
  }
}
