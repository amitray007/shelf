import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresDatabase,
  migratePostgresToLatest,
  PostgresAuthRepository,
} from '../../postgres/src/index.js';
import {
  bootstrapShelfOwner,
  createHumanAuth,
  OwnerAlreadyExistsError,
  resetShelfOwner,
} from '../src/index.js';

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

    await expect(
      resetShelfOwner({
        actors,
        installationId: 'installation-main',
        identity: {
          email: 'renamed-owner@example.test',
          name: 'Renamed Owner',
          password: 'replacement correct horse battery staple',
        },
      }),
    ).resolves.toMatchObject({
      actorId: owner.actorId,
      email: 'renamed-owner@example.test',
      name: 'Renamed Owner',
    });
    await expect(auth.authenticate(headers)).resolves.toBeUndefined();

    const oldSignIn = await auth.handle(
      new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'correct horse battery staple',
        }),
      }),
    );
    expect(oldSignIn.status).toBe(401);
    const replacementSignIn = await auth.handle(
      new Request('http://127.0.0.1:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3000' },
        body: JSON.stringify({
          email: 'renamed-owner@example.test',
          password: 'replacement correct horse battery staple',
        }),
      }),
    );
    expect(replacementSignIn.status).toBe(200);
    const replacementCookie = replacementSignIn.headers.get('set-cookie');
    const replacementHeaders = new Headers({ cookie: replacementCookie ?? '' });
    await expect(auth.authenticate(replacementHeaders)).resolves.toMatchObject({
      email: 'renamed-owner@example.test',
      name: 'Renamed Owner',
    });
    await auth.revokeCurrentSession(replacementHeaders);
    await expect(auth.authenticate(replacementHeaders)).resolves.toBeUndefined();
    await auth.close();
    await database.destroy();
  });
});

/**
 * A framed Shelf is a third-party context, and the browser applies third-party
 * cookie rules to it. `SameSite=Lax` — Better Auth's default — is withheld
 * there, so the sign-in returns 200 and sets a cookie the browser then refuses
 * to send back: the login appears to work and the next request is anonymous.
 *
 * Relaxing it costs the browser's own CSRF protection. What replaces that is
 * Better Auth's origin allowlist, which rejects a state-changing request whose
 * `Origin` is not trusted and does not depend on `SameSite` — but that check is
 * disabled under a test runner, so it is verified against a running server
 * rather than here.
 */
describePostgres('session cookies for a framed deployment', () => {
  const secret = 'test-only-secret-with-more-than-thirty-two-characters';
  const baseUrl = 'http://127.0.0.1:3000';
  const email = 'framed-owner@example.test';
  const password = 'correct horse battery staple';

  /**
   * A fresh database per test, because each one bootstraps an owner and an
   * installation accepts only one.
   */
  async function framedShelf(framed: boolean) {
    const name = `shelf_framed_test_${randomBytes(8).toString('hex')}`;
    const url = new URL(adminConnectionString ?? '');
    url.pathname = `/${name}`;
    const admin = new Pool({ connectionString: adminConnectionString });
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }

    const ownConnectionString = url.toString();
    const database = createPostgresDatabase({ connectionString: ownConnectionString });
    await migratePostgresToLatest(database);
    const auth = createHumanAuth({
      connectionString: ownConnectionString,
      baseUrl,
      secret,
      framed,
    });
    await bootstrapShelfOwner({
      humanAuth: auth,
      actors: new PostgresAuthRepository(database),
      installationId: 'installation-main',
      actorName: 'Framed Owner',
      grants: [],
      identity: { email, name: 'Framed Owner', password },
    });

    return {
      signIn() {
        return this.signInWith(password);
      },
      signInWith(attempt: string) {
        return auth.handle(
          new Request(`${baseUrl}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: baseUrl },
            body: JSON.stringify({ email, password: attempt }),
          }),
        );
      },
      authenticate: auth.authenticate.bind(auth),
      async dispose() {
        await auth.close();
        await database.destroy();
        const cleanup = new Pool({ connectionString: adminConnectionString });
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
      },
    };
  }

  it('sends a cookie a browser will keep in a frame when framing is configured', async () => {
    const shelf = await framedShelf(true);
    try {
      const response = await shelf.signIn();
      expect(response.status).toBe(200);

      // Lax is the setting that loses the session in a frame; None is the only
      // one browsers honour there, and it is invalid without Secure.
      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('SameSite=None');
      expect(cookie).toContain('Secure');
      expect(cookie).not.toContain('SameSite=Lax');
      expect(cookie).toContain('HttpOnly');

      // The cookie still resolves to the owner, so relaxing SameSite changed
      // where the browser sends it and nothing else.
      await expect(shelf.authenticate(new Headers({ cookie }))).resolves.toMatchObject({ email });
    } finally {
      await shelf.dispose();
    }
  });

  it('keeps the stricter default when no framing is configured', async () => {
    const shelf = await framedShelf(false);
    try {
      const response = await shelf.signIn();
      expect(response.status).toBe(200);

      // An unframed deployment gains nothing from None and should not pay the
      // CSRF cost of it.
      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).not.toContain('SameSite=None');
    } finally {
      await shelf.dispose();
    }
  });

  it('signs in from the trusted origin and rejects the wrong password', async () => {
    // The origin allowlist is what replaces SameSite as the CSRF defence, but
    // it cannot be exercised here: Better Auth turns its origin check off
    // whenever NODE_ENV is "test", which the runner sets, so a cross-origin
    // request would be accepted in-process and prove nothing either way. That
    // behaviour is verified against a running server instead.
    //
    // What this does pin is that relaxing SameSite left authentication itself
    // intact — the right password still works, the wrong one still does not.
    const shelf = await framedShelf(true);
    try {
      await expect(shelf.signIn().then((response) => response.status)).resolves.toBe(200);

      const wrongPassword = await shelf.signInWith('not the owner password');
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.headers.get('set-cookie')).toBeNull();
    } finally {
      await shelf.dispose();
    }
  });
});
