import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresHtmlPreviewSettingsRepository,
  PostgresInstallationInventory,
} from '../src/index.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('persistent HTML preview settings', () => {
  it('migrates, isolates installations, and preserves an explicit empty policy across connections', async () => {
    const name = `shelf_settings_${randomBytes(8).toString('hex')}`;
    const target = new URL(adminConnectionString as string);
    target.pathname = `/${name}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    await admin.query(`CREATE DATABASE ${name}`);
    let database = createPostgresDatabase({ connectionString: target.toString() });
    try {
      const migrations = await migratePostgresToLatest(database);
      expect(migrations).toContainEqual({
        migrationName: '0017_html_preview_settings',
        status: 'Success',
      });
      const repository = new PostgresHtmlPreviewSettingsRepository(database);
      expect(await repository.findTrustedResourceOrigins('installation-a')).toBeUndefined();
      await repository.saveTrustedResourceOrigins('installation-a', ['https://cdn.example']);
      await repository.saveTrustedResourceOrigins('installation-b', ['https://other.example']);
      expect(await repository.findTrustedResourceOrigins('installation-a')).toEqual([
        'https://cdn.example',
      ]);
      await repository.saveTrustedResourceOrigins('installation-a', []);
      await database.destroy();
      database = createPostgresDatabase({ connectionString: target.toString() });
      const reconnected = new PostgresHtmlPreviewSettingsRepository(database);
      expect(await reconnected.findTrustedResourceOrigins('installation-a')).toEqual([]);
      expect(await reconnected.findTrustedResourceOrigins('installation-b')).toEqual([
        'https://other.example',
      ]);
      expect(await reconnected.findTrustedResourceOrigins('installation-c')).toBeUndefined();
      expect(await new PostgresInstallationInventory(database).listInstallationIds()).toEqual([
        'installation-a',
        'installation-b',
      ]);
      await expect(
        sql`insert into shelf_html_preview_settings values ('bad', '{}'::jsonb)`.execute(database),
      ).rejects.toThrow();
    } finally {
      await database.destroy();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
