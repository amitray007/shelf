import {
  assertPostgresMigrationsCurrent,
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
  type PostgresDatabaseOptions,
  PostgresRevisionRepository,
} from '@shelf/postgres';
import {
  type ContentStorage,
  type ContentStorageConfig,
  createContentStorage,
} from '@shelf/storage';

export interface ShelfPersistenceConfig {
  postgres: PostgresDatabaseOptions;
  content: ContentStorageConfig;
}

export interface ShelfPersistence {
  contentStore: ContentStorage;
  contentReader: ContentStorage;
  revisionRepository: PostgresRevisionRepository;
  authRepository: PostgresAuthRepository;
  migrate(): Promise<void>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Assemble Shelf's production data plane without coupling core publishing or reads to a provider.
 * Migrations remain an explicit operator action and are never run implicitly by API replicas.
 */
export function createShelfPersistence(config: ShelfPersistenceConfig): ShelfPersistence {
  const contentStorage = createContentStorage(config.content);
  let database: ReturnType<typeof createPostgresDatabase>;
  try {
    database = createPostgresDatabase(config.postgres);
  } catch (error) {
    contentStorage.close();
    throw error;
  }
  return {
    contentStore: contentStorage,
    contentReader: contentStorage,
    revisionRepository: new PostgresRevisionRepository(database),
    authRepository: new PostgresAuthRepository(database),
    async migrate(): Promise<void> {
      await migratePostgresToLatest(database);
    },
    async ready(): Promise<void> {
      await Promise.all([assertPostgresMigrationsCurrent(database), contentStorage.ready()]);
    },
    async close(): Promise<void> {
      contentStorage.close();
      await database.destroy();
    },
  };
}
