import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrapShelfOwner, createAccessCredentialService, createHumanAuth } from '@shelf/auth';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
  PostgresRevisionRepository,
} from '@shelf/postgres';
import { LocalContentStorage } from '@shelf/storage';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShelfApp } from '../src/app.js';
import { createHybridAuthenticator, createShelfAuthorizer } from '../src/auth/runtime.js';

const adminConnectionString = process.env.SHELF_TEST_POSTGRES_URL;
const databaseName = `shelf_api_auth_test_${randomBytes(8).toString('hex')}`;
const connectionUrl =
  adminConnectionString === undefined ? undefined : new URL(adminConnectionString);
if (connectionUrl !== undefined) connectionUrl.pathname = `/${databaseName}`;
const connectionString = connectionUrl?.toString() ?? 'postgresql:///shelf_test_not_configured';
let contentRoot: string;

beforeAll(async () => {
  if (adminConnectionString === undefined) return;
  contentRoot = await mkdtemp(join(tmpdir(), 'shelf-auth-integration-'));
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
  const boundary = 'shelf-auth-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="README.md"\r\n',
      'Content-Type: text/markdown\r\n\r\n',
      'authenticated shelf',
      `\r\n--${boundary}--\r\n`,
    ].join(''),
  };
}

const describePostgres = adminConnectionString === undefined ? describe.skip : describe;

describePostgres('hybrid HTTP authentication', () => {
  it('uses a scoped bearer for agents and a revocable cookie session for the owner', async () => {
    const database = createPostgresDatabase({ connectionString });
    await migratePostgresToLatest(database);
    const repository = new PostgresAuthRepository(database);
    const credentials = createAccessCredentialService({ repository });
    const humanAuth = createHumanAuth({
      connectionString,
      baseUrl: 'http://127.0.0.1:3000',
      secret: 'test-only-secret-with-more-than-thirty-two-characters',
    });
    const content = new LocalContentStorage({ root: contentRoot });
    const app = await createShelfApp({
      authenticator: createHybridAuthenticator({ humanAuth, credentials, actors: repository }),
      authorizer: createShelfAuthorizer(credentials),
      humanAuth,
      contentStore: content,
      contentReader: content,
      revisionRepository: new PostgresRevisionRepository(database),
    });

    const publicSignUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        email: 'owner@example.test',
        name: 'Shelf Owner',
        password: 'correct horse battery staple',
      },
    });
    expect(publicSignUp.statusCode).toBe(400);
    const owner = await bootstrapShelfOwner({
      humanAuth,
      actors: repository,
      installationId: 'installation-main',
      actorName: 'Shelf Owner',
      identity: {
        email: 'owner@example.test',
        name: 'Shelf Owner',
        password: 'correct horse battery staple',
      },
      grants: [
        { workspaceId: 'workspace-main', action: 'file.publish' },
        { workspaceId: 'workspace-main', action: 'revision.read' },
      ],
    });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        email: 'owner@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(signIn.statusCode).toBe(200);
    const sessionCookie = signIn.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const agent = await credentials.issueAgent({
      installationId: 'installation-main',
      actorName: 'release-agent',
      createdByActorId: owner.actorId,
      grants: [{ workspaceId: 'workspace-main', action: 'file.publish' }],
    });

    const body = multipart();
    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/artifacts',
      headers: {
        ...body.headers,
        authorization: `Bearer ${agent.token}`,
        'idempotency-key': 'auth-publish',
      },
      payload: body.payload,
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().provenance.observed.actorId).toBe(agent.actorId);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-other/artifacts',
      headers: {
        ...body.headers,
        authorization: `Bearer ${agent.token}`,
        'idempotency-key': 'cross-workspace-publish',
      },
      payload: body.payload,
    });
    expect(forbidden.statusCode).toBe(403);

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${published.json().revisionId}/content`,
      headers: { cookie: sessionCookie },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe('authenticated shelf');

    await humanAuth.revokeCurrentSession(new Headers({ cookie: sessionCookie }));
    const revoked = await app.inject({
      method: 'GET',
      url: `/api/v1/revisions/${published.json().revisionId}/content`,
      headers: { cookie: sessionCookie },
    });
    expect(revoked.statusCode).toBe(401);

    await credentials.revoke({
      credentialId: agent.credentialId,
      revokedByActorId: owner.actorId,
    });
    const revokedAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/workspace-main/artifacts',
      headers: {
        ...body.headers,
        authorization: `Bearer ${agent.token}`,
        'idempotency-key': 'revoked-agent-publish',
      },
      payload: body.payload,
    });
    expect(revokedAgent.statusCode).toBe(401);

    await close(app, humanAuth.close, database.destroy.bind(database));
  });
});

async function close(
  app: FastifyInstance,
  closeHumanAuth: () => Promise<void>,
  closeDatabase: () => Promise<void>,
): Promise<void> {
  await app.close();
  await closeHumanAuth();
  await closeDatabase();
}
