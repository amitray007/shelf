import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
} from '../../postgres/src/index.js';
import { bootstrapShelfOwner, createHumanAuth, OwnerAlreadyExistsError } from '../src/index.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_auth_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  if (adminConnectionString === undefined) return;
  const admin = new Pool({ connectionString: adminConnectionString });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('human session authentication', () => {
  it('creates, resolves, and immediately revokes a database-backed session', async () => {
    const database = createPostgresDatabase({ connectionString });
    await migratePostgresToLatest(database);
    const actors = new PostgresAuthRepository(database);

    const auth = createHumanAuth({
      connectionString,
      baseUrl: 'http://127.0.0.1:3000',
      secret: 'test-only-secret-with-more-than-thirty-two-characters',
    });
    const publicSignUp = await auth.handle(
      new Request('http://127.0.0.1:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          email: 'owner@example.test',
          name: 'Shelf Owner',
          password: 'correct horse battery staple',
        }),
      }),
    );
    expect(publicSignUp.status).toBe(400);

    const owner = await bootstrapShelfOwner({
      humanAuth: auth,
      actors,
      installationId: 'installation-main',
      actorName: 'Shelf Owner',
      grants: [
        { workspaceId: 'workspace-main', action: 'file.publish' },
        { workspaceId: 'workspace-main', action: 'revision.read' },
      ],
      identity: {
        email: 'owner@example.test',
        name: 'Shelf Owner',
        password: 'correct horse battery staple',
      },
    });
    expect(owner).toMatchObject({
      installationId: 'installation-main',
      email: 'owner@example.test',
      name: 'Shelf Owner',
    });
    await expect(
      bootstrapShelfOwner({
        humanAuth: auth,
        actors,
        installationId: 'installation-main',
        actorName: 'Another Owner',
        grants: [],
        identity: {
          email: 'another@example.test',
          name: 'Another Owner',
          password: 'another correct horse battery staple',
        },
      }),
    ).rejects.toBeInstanceOf(OwnerAlreadyExistsError);

    const signIn = await auth.handle(
      new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'correct horse battery staple',
        }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');

    const localhostSignIn = await auth.handle(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'correct horse battery staple',
        }),
      }),
    );
    expect(localhostSignIn.status).toBe(200);

    const headers = new Headers({ cookie: cookie ?? '' });
    await expect(auth.authenticate(headers)).resolves.toMatchObject({
      email: 'owner@example.test',
    });

    await auth.revokeCurrentSession(headers);
    await expect(auth.authenticate(headers)).resolves.toBeUndefined();
    await auth.close();
    await database.destroy();
  });
});
