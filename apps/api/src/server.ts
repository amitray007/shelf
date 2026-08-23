import { randomBytes } from 'node:crypto';

import {
  createAccessCredentialService,
  createDashboardAccessService,
  createHumanAuth,
  type HumanAuth,
} from '@shelf/auth';
import type { FastifyInstance } from 'fastify';

import { createShelfApp } from './app.js';
import { createHybridAuthenticator, createShelfAuthorizer } from './auth/runtime.js';
import { createReadinessState, type ReadinessState } from './health.js';
import { createShelfPersistence, type ShelfPersistence } from './persistence.js';
import type { ShelfServerConfig } from './server-config.js';
import { createHmacShareSecurityCodecs } from './share-capability.js';

export interface ShelfServer {
  readonly app: FastifyInstance;
  readonly readiness: ReadinessState;
  start(): Promise<string>;
  close(): Promise<void>;
}

export const COMMENT_ABUSE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const COMMENT_ABUSE_CLEANUP_BATCH_SIZE = 500;
const COMMENT_ABUSE_CLEANUP_MAX_BATCHES = 10;
export const ARTIFACT_RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const ARTIFACT_RETENTION_CLEANUP_BATCH_SIZE = 100;
const ARTIFACT_RETENTION_CLEANUP_MAX_BATCHES = 10;

export interface CommentAbuseCleanupSchedulerOptions {
  intervalMs?: number;
  batchSize?: number;
  now?: () => Date;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

interface CommentAbuseCleanupScheduler {
  start(): void;
  stop(): Promise<void>;
}

export type ArtifactRetentionCleanupSchedulerOptions = CommentAbuseCleanupSchedulerOptions;

export function createArtifactRetentionCleanupScheduler(
  persistence: Pick<ShelfPersistence, 'revisionRepository' | 'contentStore'>,
  logger: FastifyInstance['log'],
  options: ArtifactRetentionCleanupSchedulerOptions = {},
): CommentAbuseCleanupScheduler {
  const intervalMs = options.intervalMs ?? ARTIFACT_RETENTION_CLEANUP_INTERVAL_MS;
  const batchSize = options.batchSize ?? ARTIFACT_RETENTION_CLEANUP_BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function drain(): Promise<void> {
    if (running !== undefined) return running;
    running = (async () => {
      try {
        for (let batch = 0; batch < ARTIFACT_RETENTION_CLEANUP_MAX_BATCHES; batch += 1) {
          const count = await persistence.revisionRepository.trashDueArtifacts(now(), batchSize);
          if (count < batchSize) break;
        }
        for (let batch = 0; batch < ARTIFACT_RETENTION_CLEANUP_MAX_BATCHES; batch += 1) {
          const count = await persistence.revisionRepository.purgeExpiredArtifacts(
            now(),
            batchSize,
          );
          if (count < batchSize) break;
        }
        const queued = await persistence.revisionRepository.listQueuedContentPurges(batchSize * 5);
        for (const item of queued) {
          try {
            await persistence.contentStore.deleteSealed(item.content_id);
            await persistence.revisionRepository.completeContentPurge(item.content_id);
          } catch (error) {
            await persistence.revisionRepository.failContentPurge(item.content_id, now());
            logger.error(
              { err: error, contentId: item.content_id, artifactId: item.artifact_id },
              'Shelf retained a failed content purge for retry.',
            );
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Shelf artifact retention cleanup failed.');
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    start() {
      if (timer !== undefined) return;
      void drain();
      timer = schedule(() => void drain(), intervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    },
    async stop() {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      await running;
    },
  };
}

export function createCommentAbuseCleanupScheduler(
  repository: ShelfPersistence['commentRepository'],
  logger: FastifyInstance['log'],
  options: CommentAbuseCleanupSchedulerOptions = {},
): CommentAbuseCleanupScheduler {
  const intervalMs = options.intervalMs ?? COMMENT_ABUSE_CLEANUP_INTERVAL_MS;
  const batchSize = options.batchSize ?? COMMENT_ABUSE_CLEANUP_BATCH_SIZE;
  const now = options.now ?? (() => new Date());
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  async function drain(): Promise<void> {
    if (running !== undefined) return running;
    running = (async () => {
      try {
        for (let batch = 0; batch < COMMENT_ABUSE_CLEANUP_MAX_BATCHES; batch += 1) {
          const removed = await repository.cleanupExpiredAbuse(now().toISOString(), batchSize);
          if (removed < batchSize) break;
        }
      } catch (error) {
        logger.error({ err: error }, 'Shelf comment abuse metadata cleanup failed.');
      } finally {
        running = undefined;
      }
    })();
    return running;
  }

  return {
    start() {
      if (timer !== undefined) return;
      void drain();
      timer = schedule(() => void drain(), intervalMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    },
    async stop() {
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
      await running;
    },
  };
}

export async function createShelfServer(config: ShelfServerConfig): Promise<ShelfServer> {
  const persistence = createShelfPersistence(config.persistence);
  const shareSecurity = createHmacShareSecurityCodecs(config.share.signingKey);
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
      dashboardAccess: createDashboardAccessService({
        repository: persistence.authRepository,
        credentials,
      }),
      humanAuth: shelfHumanAuth,
      contentStore: persistence.contentStore,
      contentReader: persistence.contentReader,
      multipartLimits: { fileSize: config.maxFileBytes },
      revisionRepository: persistence.revisionRepository,
      artifactDeletionRepository: persistence.artifactDeletionRepository,
      shareRepository: persistence.shareRepository,
      commentRepository: persistence.commentRepository,
      privacyKey: config.privacy?.key ?? randomBytes(32),
      shareCapabilityCodec: shareSecurity.capability,
      viewerSessionTokenCodec: shareSecurity.viewerSession,
      health: readiness,
      logger: true,
      ...(config.rendererPublicOrigin === undefined
        ? {}
        : { rendererPublicOrigin: config.rendererPublicOrigin }),
      ...(config.webRoot === undefined ? {} : { webRoot: config.webRoot }),
    });
    app = shelfApp;
    const abuseCleanup = createCommentAbuseCleanupScheduler(
      persistence.commentRepository,
      shelfApp.log,
      config.commentAbuseCleanup,
    );
    const retentionCleanup = createArtifactRetentionCleanupScheduler(
      persistence,
      shelfApp.log,
      config.artifactRetentionCleanup,
    );

    let closePromise: Promise<void> | undefined;
    return {
      app: shelfApp,
      readiness,
      async start() {
        await persistence.ready();
        const address = await shelfApp.listen({ host: config.host, port: config.port });
        readiness.markStarted();
        abuseCleanup.start();
        retentionCleanup.start();
        return address;
      },
      close() {
        closePromise ??= closeServer(readiness, shelfApp, shelfHumanAuth, persistence, [
          abuseCleanup,
          retentionCleanup,
        ]);
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
  cleanupSchedulers: CommentAbuseCleanupScheduler[] = [],
): Promise<void> {
  readiness.markStopping();
  const failures: unknown[] = [];
  const cleanupResults = await Promise.allSettled(
    cleanupSchedulers.map((scheduler) => scheduler.stop()),
  );
  for (const result of cleanupResults)
    if (result.status === 'rejected') failures.push(result.reason);
  await app.close().catch((error: unknown) => failures.push(error));
  const dependencyResults = await Promise.allSettled([humanAuth.close(), persistence.close()]);
  for (const result of dependencyResults)
    if (result.status === 'rejected') failures.push(result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Shelf shutdown failed.');
}
