import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';
import { createShelfPersistence, type ShelfPersistence } from '../src/persistence.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_api_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
let contentRoot: string;

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  contentRoot = await mkdtemp(join(tmpdir(), 'shelf-persistence-integration-'));
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

function multipart() {
  const boundary = 'shelf-persistence-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="README.md"\r\n',
      'Content-Type: text/markdown\r\n\r\n',
      'persistent shelf',
      `\r\n--${boundary}--\r\n`,
    ].join(''),
  };
}

function persistence(): ShelfPersistence {
  return createShelfPersistence({
    postgres: { connectionString },
    content: { driver: 'local', root: contentRoot },
  });
}

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('PostgreSQL with local content storage', () => {
  it('replays a publish and delivers its bytes after the complete data plane restarts', async () => {
    const firstPersistence = persistence();
    await firstPersistence.migrate();
    const firstApp = await createShelfApp({
      authenticator: {
        async authenticate() {
          return { installationId: 'installation-main', actorId: 'actor-agent' };
        },
      },
      authorizer: { async authorize() {} },
      ...firstPersistence,
    });
    const body = multipart();
    let firstRevisionId: string;
    try {
      const first = await firstApp.inject({
        method: 'POST',
        url: '/api/v1/workspaces/workspace-main/artifacts',
        headers: {
          ...body.headers,
          authorization: 'Bearer test',
          'idempotency-key': 'persistent-publish',
        },
        payload: body.payload,
      });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ replayed: false, byteCount: 16 });
      firstRevisionId = first.json().revisionId;
    } finally {
      await closeDataPlane(firstApp, firstPersistence);
    }

    const restartedPersistence = persistence();
    const restartedApp = await createShelfApp({
      authenticator: {
        async authenticate() {
          return { installationId: 'installation-main', actorId: 'actor-agent' };
        },
      },
      authorizer: { async authorize() {} },
      ...restartedPersistence,
    });
    try {
      const replay = await restartedApp.inject({
        method: 'POST',
        url: '/api/v1/workspaces/workspace-main/artifacts',
        headers: {
          ...body.headers,
          authorization: 'Bearer test',
          'idempotency-key': 'persistent-publish',
        },
        payload: body.payload,
      });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ revisionId: firstRevisionId, replayed: true });

      const download = await restartedApp.inject({
        method: 'GET',
        url: `/api/v1/revisions/${firstRevisionId}/content`,
        headers: { authorization: 'Bearer test' },
      });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.toString()).toBe('persistent shelf');
    } finally {
      await closeDataPlane(restartedApp, restartedPersistence);
    }
  });
});

async function closeDataPlane(app: FastifyInstance, dataPlane: ShelfPersistence): Promise<void> {
  await app.close();
  await dataPlane.close();
}
