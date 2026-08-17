import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

import type { ShelfPostgresDatabase } from './database.js';
import { initialMigration } from './migrations/0001_initial.js';
import { humanAuthMigration } from './migrations/0002_human_auth.js';
import { accessCredentialsMigration } from './migrations/0003_access_credentials.js';
import { artifactLifecycleMigration } from './migrations/0004_artifact_lifecycle.js';
import { folderSnapshotsMigration } from './migrations/0005_folder_snapshots.js';
import { sharesMigration } from './migrations/0006_shares.js';

const migrations = Object.freeze<Record<string, Migration>>({
  '0001_initial': initialMigration,
  '0002_human_auth': humanAuthMigration,
  '0003_access_credentials': accessCredentialsMigration,
  '0004_artifact_lifecycle': artifactLifecycleMigration,
  '0005_folder_snapshots': folderSnapshotsMigration,
  '0006_shares': sharesMigration,
});

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export interface MigrationResult {
  migrationName: string;
  status: 'Success' | 'Error' | 'NotExecuted';
}

export async function migratePostgresToLatest(
  database: ShelfPostgresDatabase,
): Promise<MigrationResult[]> {
  const migrator = new Migrator({ db: database, provider });
  const result = await migrator.migrateToLatest();
  if (result.error !== undefined) {
    throw new Error('PostgreSQL migration failed.', { cause: result.error });
  }
  return (result.results ?? []).map(({ migrationName, status }) => ({ migrationName, status }));
}

export async function assertPostgresMigrationsCurrent(
  database: ShelfPostgresDatabase,
): Promise<void> {
  const applied = await new Migrator({ db: database, provider }).getMigrations();
  if (
    applied.length !== Object.keys(migrations).length ||
    applied.some((item) => item.executedAt === undefined)
  ) {
    throw new Error('PostgreSQL migrations are not current. Run shelf-admin migrate.');
  }
}
