import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

export interface HumanIdentity {
  userId: string;
  email: string;
  name: string;
}

export interface HumanAuth {
  readonly baseUrl: string;
  handle(request: Request): Promise<Response>;
  bootstrapOwner(input: BootstrapOwnerInput): Promise<HumanIdentity>;
  authenticate(headers: Headers): Promise<HumanIdentity | undefined>;
  revokeCurrentSession(headers: Headers): Promise<void>;
  close(): Promise<void>;
}

export interface BootstrapOwnerInput {
  email: string;
  name: string;
  password: string;
}

export interface CreateHumanAuthOptions {
  connectionString: string;
  baseUrl: string;
  secret: string;
  /**
   * Whether Shelf is embedded in another origin's page.
   *
   * A framed Shelf is a third-party context, and browsers withhold a
   * `SameSite=Lax` cookie there — the sign-in succeeds, the cookie is
   * discarded, and the next request arrives unauthenticated. `SameSite=None`
   * is the only setting that survives, and it requires `Secure`.
   *
   * `SameSite=None` is permission to send a third-party cookie, not permission
   * to store one. A browser that blocks third-party cookies — Safari, and
   * Chromium with tracking protection on — drops it before it is ever written,
   * which looks identical: sign-in returns 200 and nothing is saved.
   * `Partitioned` is what those browsers do allow. It gives the frame its own
   * cookie jar, keyed by the embedding site, so the cookie cannot be used to
   * follow anyone between sites and is kept on that basis.
   *
   * Off by default: it costs the browser's own CSRF protection, so only a
   * deployment that needs framing should pay for it. Better Auth still checks
   * `Origin` against `trustedOrigins` on every state-changing request, which
   * does not depend on `SameSite` and remains the real defence.
   */
  framed?: boolean;
}

function trustedOriginsFor(baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const origins = new Set([base.origin]);
  // Host-local development commonly switches between these equivalent loopback
  // names. Keep production origin checks strict while allowing that safe pair.
  if (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)) {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const alias = new URL(base.origin);
      alias.hostname = hostname;
      origins.add(alias.origin);
    }
  }
  return [...origins];
}

export function createHumanAuth(options: CreateHumanAuthOptions): HumanAuth {
  const pool = new Pool({
    connectionString: options.connectionString,
    options: '-c search_path=auth',
  });
  const shared = {
    database: pool,
    baseURL: options.baseUrl,
    secret: options.secret,
    session: { cookieCache: { enabled: false } },
    trustedOrigins: trustedOriginsFor(options.baseUrl),
    // `Secure` is required by both `SameSite=None` and `Partitioned`, and
    // browsers drop the cookie without it. Shelf already refuses to serve
    // plaintext outside loopback, so a framed deployment is always HTTPS.
    ...(options.framed === true
      ? {
          advanced: {
            defaultCookieAttributes: {
              sameSite: 'none' as const,
              secure: true,
              partitioned: true,
            },
          },
        }
      : {}),
  };
  const auth = betterAuth({
    ...shared,
    emailAndPassword: { enabled: true, disableSignUp: true },
  });
  const bootstrapAuth = betterAuth({
    ...shared,
    emailAndPassword: { enabled: true, disableSignUp: false, autoSignIn: false },
  });

  return {
    baseUrl: options.baseUrl,
    handle(request) {
      return auth.handler(request);
    },
    async bootstrapOwner(input) {
      let created: Awaited<ReturnType<typeof bootstrapAuth.api.signUpEmail>>;
      try {
        created = await bootstrapAuth.api.signUpEmail({ body: input });
      } catch (signUpError) {
        try {
          created = await bootstrapAuth.api.signInEmail({
            body: { email: input.email, password: input.password },
          });
        } catch {
          throw signUpError;
        }
      }
      return {
        userId: created.user.id,
        email: created.user.email,
        name: created.user.name,
      };
    },
    async authenticate(headers) {
      const session = await auth.api.getSession({ headers });
      if (session === null) return undefined;
      return {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
      };
    },
    async revokeCurrentSession(headers) {
      await auth.api.signOut({ headers });
    },
    async close() {
      await pool.end();
    },
  };
}
