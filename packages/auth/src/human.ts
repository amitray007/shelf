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
