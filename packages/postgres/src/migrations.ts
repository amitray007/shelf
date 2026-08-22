import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';

import type { ShelfPostgresDatabase } from './database.js';
import { initialMigration } from './migrations/0001_initial.js';
import { humanAuthMigration } from './migrations/0002_human_auth.js';
import { accessCredentialsMigration } from './migrations/0003_access_credentials.js';
import { artifactLifecycleMigration } from './migrations/0004_artifact_lifecycle.js';
import { folderSnapshotsMigration } from './migrations/0005_folder_snapshots.js';
import { sharesMigration } from './migrations/0006_shares.js';
import { artifactDeletionMigration } from './migrations/0007_artifact_deletion.js';
import { workspacesMigration } from './migrations/0008_workspaces.js';
import { shareAccessPoliciesMigration } from './migrations/0009_share_access_policies.js';
import { permanentPublicSharesMigration } from './migrations/0010_permanent_public_shares.js';
import { artifactDefaultSharesMigration } from './migrations/0011_artifact_default_shares.js';
import { commentsMigration } from './migrations/0012_comments.js';
import { actorDisplayNamesMigration } from './migrations/0013_actor_display_names.js';
import { workspaceDeletionMigration } from './migrations/0014_workspace_deletion.js';
import { artifactRetentionMigration } from './migrations/0015_artifact_retention.js';

const migrations = Object.freeze<Record<string, Migration>>({
  '0001_initial': initialMigration,
  '0002_human_auth': humanAuthMigration,
  '0003_access_credentials': accessCredentialsMigration,
  '0004_artifact_lifecycle': artifactLifecycleMigration,
  '0005_folder_snapshots': folderSnapshotsMigration,
  '0006_shares': sharesMigration,
  '0007_artifact_deletion': artifactDeletionMigration,
  '0008_workspaces': workspacesMigration,
  '0009_share_access_policies': shareAccessPoliciesMigration,
  '0010_permanent_public_shares': permanentPublicSharesMigration,
  '0011_artifact_default_shares': artifactDefaultSharesMigration,
  '0012_comments': commentsMigration,
  '0013_actor_display_names': actorDisplayNamesMigration,
  '0014_workspace_deletion': workspaceDeletionMigration,
  '0015_artifact_retention': artifactRetentionMigration,
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
