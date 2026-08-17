import { randomBytes, randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import type { HumanAuth } from '@shelf/auth';
import {
  ErrorEnvelopeSchema,
  FolderPublishResultSchema,
  FolderTreePageSchema,
  PublicShareResolutionSchema,
  PublishResultSchema,
  RevisionComparisonSchema,
  ShareCreateResultSchema,
  ShareManagementSummarySchema,
  SharePageSchema,
} from '@shelf/contracts';
import type {
  ArtifactCatalogRepository,
  ArtifactIdentityRepository,
  ArtifactLifecycleRepository,
  Authorizer,
  ContentReader,
  ContentStore,
  FolderRevisionRepository,
  RevisionComparisonRepository,
  RevisionRepository,
  ShareCapabilityCodec,
  ShareClock,
  ShareIdGenerator,
  ShareRepository,
} from '@shelf/core';
import Fastify, { type FastifyInstance } from 'fastify';

import { MemoryRevisionRepository } from './adapters/memory-revision-repository.js';
import { MemoryShareRepository } from './adapters/memory-share-repository.js';
import { TemporaryContentStore } from './adapters/temporary-content-store.js';
import { registerHumanAuthRoutes } from './auth/runtime.js';
import type { Authenticator } from './authenticate.js';
import { type ReadinessState, registerHealthRoutes } from './health.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { FolderMultipartOpenApiSchema, registerFolderRoutes } from './routes/folders.js';
import { PublishMultipartOpenApiSchema, registerPublishRoute } from './routes/publish.js';
import { registerRevisionRoutes } from './routes/revisions.js';
import { registerShareRoutes } from './routes/shares.js';
import { createHmacShareCapabilityCodec } from './share-capability.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    shelfMultipartBody?: 'file' | 'folder';
  }
}

export type { AuthenticationContext, Authenticator } from './authenticate.js';

export interface ShelfMultipartLimits {
  fieldNameSize: number;
  fieldSize: number;
  fields: number;
  fileSize: number;
  files: number;
  headerPairs: number;
  parts: number;
}

export const DEFAULT_MULTIPART_LIMITS: ShelfMultipartLimits = Object.freeze({
  fieldNameSize: 64,
  fieldSize: 16 * 1024,
  fields: 1,
  fileSize: 10 * 1024 * 1024,
  files: 1,
  headerPairs: 64,
  parts: 2,
});

function withoutNestedSchemaIds<T>(schema: T): T {
  const copy = structuredClone(schema);
  function visit(value: unknown, root: boolean): void {
    if (typeof value !== 'object' || value === null) return;
    if (!root && !Array.isArray(value)) delete (value as Record<string, unknown>).$id;
    for (const child of Object.values(value)) visit(child, false);
  }
  visit(copy, true);
  return copy;
}

export interface ShelfAppDependencies {
  authenticator: Authenticator;
  authorizer: Authorizer;
  contentStore: ContentStore;
  contentReader: ContentReader;
  revisionRepository: RevisionRepository &
    ArtifactIdentityRepository &
    ArtifactCatalogRepository &
    ArtifactLifecycleRepository &
    FolderRevisionRepository &
    RevisionComparisonRepository;
  shareRepository: ShareRepository;
  shareCapabilityCodec: ShareCapabilityCodec;
  shareClock?: ShareClock;
  generateShareId?: ShareIdGenerator;
}

export interface CreateShelfAppOptions {
  stagingRoot?: string;
  authenticator: Authenticator;
  authorizer: Authorizer;
  contentStore?: ContentStore;
  contentReader?: ContentReader;
  revisionRepository?: RevisionRepository &
    ArtifactIdentityRepository &
    ArtifactCatalogRepository &
    ArtifactLifecycleRepository &
    FolderRevisionRepository &
    RevisionComparisonRepository;
  shareRepository?: ShareRepository;
  shareCapabilityCodec?: ShareCapabilityCodec;
  shareClock?: ShareClock;
  generateShareId?: ShareIdGenerator;
  multipartLimits?: Partial<ShelfMultipartLimits>;
  logger?: boolean;
  humanAuth?: HumanAuth;
  health?: ReadinessState;
}

export async function createShelfApp(options: CreateShelfAppOptions): Promise<FastifyInstance> {
  if (options.authenticator === undefined) {
    throw new Error('Shelf requires an explicit authenticator.');
  }
  if ((options.contentStore === undefined) !== (options.contentReader === undefined)) {
    throw new Error('Shelf requires contentStore and contentReader to be supplied together.');
  }
  let contentStore = options.contentStore;
  let contentReader = options.contentReader;
  if (contentStore === undefined || contentReader === undefined) {
    if (options.stagingRoot === undefined) {
      throw new Error('Shelf requires stagingRoot when content adapters are not supplied.');
    }
    const temporaryContentStore = new TemporaryContentStore(options.stagingRoot);
    contentStore = temporaryContentStore;
    contentReader = temporaryContentStore;
  }
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
  });
  const limits = { ...DEFAULT_MULTIPART_LIMITS, ...options.multipartLimits };
  const revisionRepository = options.revisionRepository ?? new MemoryRevisionRepository();
  const dependencies: ShelfAppDependencies = {
    authenticator: options.authenticator,
    authorizer: options.authorizer,
    contentStore,
    contentReader,
    revisionRepository,
    shareRepository: options.shareRepository ?? new MemoryShareRepository(revisionRepository),
    shareCapabilityCodec:
      options.shareCapabilityCodec ?? createHmacShareCapabilityCodec(randomBytes(32)),
    ...(options.shareClock === undefined ? {} : { shareClock: options.shareClock }),
    ...(options.generateShareId === undefined ? {} : { generateShareId: options.generateShareId }),
  };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Shelf API', version: '1.0.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    },
    transform({ schema, url, route }) {
      if (route.config?.shelfMultipartBody === 'file') {
        return { schema: { ...schema, body: PublishMultipartOpenApiSchema }, url };
      }
      if (route.config?.shelfMultipartBody === 'folder') {
        return { schema: { ...schema, body: FolderMultipartOpenApiSchema }, url };
      }
      return { schema, url };
    },
  });
  await app.register(multipart, { throwFileSizeLimit: true, limits });
  if (options.health !== undefined) registerHealthRoutes(app, options.health);
  if (options.humanAuth !== undefined) await registerHumanAuthRoutes(app, options.humanAuth);
  app.addSchema(PublishResultSchema);
  app.addSchema(FolderPublishResultSchema);
  app.addSchema(FolderTreePageSchema);
  app.addSchema(ErrorEnvelopeSchema);
  app.addSchema(RevisionComparisonSchema);
  app.addSchema(withoutNestedSchemaIds(ShareManagementSummarySchema));
  app.addSchema(withoutNestedSchemaIds(ShareCreateResultSchema));
  app.addSchema(withoutNestedSchemaIds(SharePageSchema));
  app.addSchema(withoutNestedSchemaIds(PublicShareResolutionSchema));
  registerErrorHandler(app);
  await registerPublishRoute(app, dependencies, limits);
  await registerFolderRoutes(app, dependencies);
  await registerArtifactRoutes(app, dependencies);
  await registerRevisionRoutes(app, dependencies);
  await registerShareRoutes(app, dependencies);
  await app.ready();
  return app;
}
