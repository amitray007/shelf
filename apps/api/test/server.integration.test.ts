import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShelfPersistence } from '../src/persistence.js';
import { createShelfServer } from '../src/server.js';
import { DEFAULT_MAX_FILE_BYTES, type ShelfServerConfig } from '../src/server-config.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_server_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
let contentRoot = '';

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  contentRoot = await mkdtemp(join(tmpdir(), 'shelf-server-integration-'));
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  await rm(contentRoot, { force: true, recursive: true });
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('production server assembly', () => {
  it('refuses missing migrations, then serves health and closes idempotently after explicit migration', async () => {
    const config: ShelfServerConfig = {
      host: '127.0.0.1',
      port: 0,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      installationId: 'installation-main',
      auth: {
        baseUrl: 'http://127.0.0.1:3000',
        secret: 'server-integration-secret-at-least-32-characters',
      },
      share: { signingKey: 'server-share-signing-key-at-least-32-characters' },
      persistence: {
        postgres: { connectionString },
        content: { driver: 'local', root: contentRoot },
      },
    };

    const unmigrated = await createShelfServer(config);
    await expect(unmigrated.start()).rejects.toThrow('migrations');
    await unmigrated.close();

    const migration = createShelfPersistence(config.persistence);
    await migration.migrate();
    await migration.close();

    const server = await createShelfServer(config);
    const address = await server.start();
    try {
      await expect(
        fetch(`${address}/health/live`).then((response) => response.json()),
      ).resolves.toEqual({
        status: 'ok',
      });
      await expect(
        fetch(`${address}/health/ready`).then((response) => response.json()),
      ).resolves.toEqual({
        status: 'ready',
      });
    } finally {
      await Promise.all([server.close(), server.close()]);
    }
  });
});
