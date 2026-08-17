import { createAccessCredentialService, createHumanAuth, type HumanAuth } from '@shelf/auth';
import type { FastifyInstance } from 'fastify';

import { createShelfApp } from './app.js';
import { createHybridAuthenticator, createShelfAuthorizer } from './auth/runtime.js';
import { createReadinessState, type ReadinessState } from './health.js';
import { createShelfPersistence, type ShelfPersistence } from './persistence.js';
import type { ShelfServerConfig } from './server-config.js';
import { createHmacShareCapabilityCodec } from './share-capability.js';

export interface ShelfServer {
  readonly app: FastifyInstance;
  readonly readiness: ReadinessState;
  start(): Promise<string>;
  close(): Promise<void>;
}

export async function createShelfServer(config: ShelfServerConfig): Promise<ShelfServer> {
  const persistence = createShelfPersistence(config.persistence);
  let humanAuth: HumanAuth | undefined;
  let app: FastifyInstance | undefined;
  try {
    const shelfHumanAuth = createHumanAuth({
      connectionString: config.persistence.postgres.connectionString,
      baseUrl: config.auth.baseUrl,
      secret: config.auth.secret,
    });
    humanAuth = shelfHumanAuth;
    const credentials = createAccessCredentialService({ repository: persistence.authRepository });
    const readiness = createReadinessState(() => persistence.ready());
    const shelfApp = await createShelfApp({
      authenticator: createHybridAuthenticator({
        humanAuth: shelfHumanAuth,
        credentials,
        actors: persistence.authRepository,
      }),
      authorizer: createShelfAuthorizer(credentials),
      humanAuth: shelfHumanAuth,
      contentStore: persistence.contentStore,
      contentReader: persistence.contentReader,
      revisionRepository: persistence.revisionRepository,
      shareRepository: persistence.shareRepository,
      shareCapabilityCodec: createHmacShareCapabilityCodec(config.share.signingKey),
      health: readiness,
      logger: true,
    });
    app = shelfApp;

    let closePromise: Promise<void> | undefined;
    return {
      app: shelfApp,
      readiness,
      async start() {
        await persistence.ready();
        const address = await shelfApp.listen({ host: config.host, port: config.port });
        readiness.markStarted();
        return address;
      },
      close() {
        closePromise ??= closeServer(readiness, shelfApp, shelfHumanAuth, persistence);
        return closePromise;
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await humanAuth?.close().catch(() => undefined);
    await persistence.close().catch(() => undefined);
    throw error;
  }
}

async function closeServer(
  readiness: ReadinessState,
  app: FastifyInstance,
  humanAuth: HumanAuth,
  persistence: ShelfPersistence,
): Promise<void> {
  readiness.markStopping();
  const failures: unknown[] = [];
  await app.close().catch((error: unknown) => failures.push(error));
  const dependencyResults = await Promise.allSettled([humanAuth.close(), persistence.close()]);
  for (const result of dependencyResults)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Shelf shutdown failed.');
}
