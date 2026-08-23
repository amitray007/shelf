import { randomBytes, randomUUID } from 'node:crypto';

import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import type { DashboardAccessService, HumanAuth } from '@shelf/auth';
import {
  ArtifactDefaultSharesSchema,
  ArtifactDeletionResultSchema,
  ArtifactPermanentDeletionResultSchema,
  ArtifactRecoveryResultSchema,
  CommentPostSchema,
  CommentSummarySchema,
  CommentThreadPageSchema,
  CommentThreadSchema,
  DashboardCredentialIssueSchema,
  DashboardCredentialPageSchema,
  DashboardCredentialRevokeSchema,
  DashboardSessionSchema,
  ErrorEnvelopeSchema,
  FolderPublishResultSchema,
  FolderTreePageSchema,
  ProtectedSessionAuthoritySchema,
  ProtectedSessionEstablishInputSchema,
  PublicShareResolutionSchema,
  PublishResultSchema,
  RevisionComparisonSchema,
  ShareCreateInputSchema,
  ShareCreateResultSchema,
  ShareManagementSummarySchema,
  SharePageSchema,
  TrashEmptyResultSchema,
  WorkspaceCreateResultSchema,
  WorkspaceDeleteResultSchema,
} from '@shelf/contracts';
import type {
  ArtifactCatalogRepository,
  ArtifactDeletionRepository,
  ArtifactIdentityRepository,
  ArtifactLifecycleRepository,
  ArtifactRetentionRepository,
  Authorizer,
  CommentRepository,
  ContentReader,
  ContentStore,
  FolderRevisionRepository,
  PublicShareCodeGenerator,
  RevisionComparisonRepository,
  RevisionRepository,
  ShareCapabilityCodec,
  ShareClock,
  ShareIdGenerator,
  ShareRepository,
} from '@shelf/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MemoryArtifactDeletionRepository } from './adapters/memory-artifact-deletion-repository.js';
import { MemoryCommentRepository } from './adapters/memory-comment-repository.js';
import { MemoryRevisionRepository } from './adapters/memory-revision-repository.js';
import { MemoryShareRepository } from './adapters/memory-share-repository.js';
import { TemporaryContentStore } from './adapters/temporary-content-store.js';
import { registerHumanAuthRoutes } from './auth/runtime.js';
import type { Authenticator } from './authenticate.js';
import { type ReadinessState, registerHealthRoutes } from './health.js';
import { registerErrorHandler } from './plugins/errors.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { FolderMultipartOpenApiSchema, registerFolderRoutes } from './routes/folders.js';
import { registerPublicConfigRoute } from './routes/public-config.js';
import { PublishMultipartOpenApiSchema, registerPublishRoute } from './routes/publish.js';
import { registerRevisionRoutes } from './routes/revisions.js';
import { registerShareRoutes } from './routes/shares.js';
import { createHmacShareSecurityCodecs, type ViewerSessionTokenCodec } from './share-capability.js';
import { registerWebApp } from './web-app.js';

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
    ArtifactRetentionRepository &
    FolderRevisionRepository &
    RevisionComparisonRepository;
  shareRepository: ShareRepository;
  commentRepository: CommentRepository;
  artifactDeletionRepository: ArtifactDeletionRepository;
  artifactClock?: () => Date;
  shareCapabilityCodec: ShareCapabilityCodec;
  viewerSessionTokenCodec: ViewerSessionTokenCodec;
  shareClock?: ShareClock;
  generateShareId?: ShareIdGenerator;
  generatePublicCode?: PublicShareCodeGenerator;
  privacyKey: string | Uint8Array;
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
    ArtifactRetentionRepository &
    FolderRevisionRepository &
    RevisionComparisonRepository;
  shareRepository?: ShareRepository;
  artifactDeletionRepository?: ArtifactDeletionRepository;
  artifactClock?: () => Date;
  shareCapabilityCodec?: ShareCapabilityCodec;
  viewerSessionTokenCodec?: ViewerSessionTokenCodec;
  shareClock?: ShareClock;
  generateShareId?: ShareIdGenerator;
  generatePublicCode?: PublicShareCodeGenerator;
  commentRepository?: CommentRepository;
  privacyKey?: string | Uint8Array;
  multipartLimits?: Partial<ShelfMultipartLimits>;
  logger?: FastifyServerOptions['logger'];
  humanAuth?: HumanAuth;
  health?: ReadinessState;
  rendererPublicOrigin?: string;
  webRoot?: string;
  dashboardAccess?: DashboardAccessService;
}

function isArtifactDeletionRepository(value: object): value is ArtifactDeletionRepository {
  const candidate = value as Partial<Record<keyof ArtifactDeletionRepository, unknown>>;
  return (
    typeof candidate.findArtifactForDeletion === 'function' &&
    typeof candidate.deleteArtifact === 'function' &&
    typeof candidate.recoverArtifact === 'function'
  );
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
  const shareRepository = options.shareRepository ?? new MemoryShareRepository(revisionRepository);
  const commentRepository = options.commentRepository ?? new MemoryCommentRepository();
  let artifactDeletionRepository = options.artifactDeletionRepository;
  if (
    artifactDeletionRepository === undefined &&
    revisionRepository instanceof MemoryRevisionRepository &&
    shareRepository instanceof MemoryShareRepository
  ) {
    artifactDeletionRepository = new MemoryArtifactDeletionRepository(
      revisionRepository,
      shareRepository,
    );
  } else if (
    artifactDeletionRepository === undefined &&
    isArtifactDeletionRepository(revisionRepository)
  ) {
    artifactDeletionRepository = revisionRepository;
  }
  if (artifactDeletionRepository === undefined) {
    throw new Error(
      'Shelf requires artifactDeletionRepository when the revision repository does not implement artifact deletion.',
    );
  }
  const defaultSecurityCodecs = createHmacShareSecurityCodecs(randomBytes(32));
  const dependencies: ShelfAppDependencies = {
    authenticator: options.authenticator,
    authorizer: options.authorizer,
    contentStore,
    contentReader,
    revisionRepository,
    shareRepository,
    commentRepository,
    privacyKey: options.privacyKey ?? randomBytes(32),
    artifactDeletionRepository,
    ...(options.artifactClock === undefined ? {} : { artifactClock: options.artifactClock }),
    shareCapabilityCodec: options.shareCapabilityCodec ?? defaultSecurityCodecs.capability,
    viewerSessionTokenCodec: options.viewerSessionTokenCodec ?? defaultSecurityCodecs.viewerSession,
    ...(options.shareClock === undefined ? {} : { shareClock: options.shareClock }),
    ...(options.generateShareId === undefined ? {} : { generateShareId: options.generateShareId }),
    ...(options.generatePublicCode === undefined
      ? {}
      : { generatePublicCode: options.generatePublicCode }),
  };

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Shelf API', version: '1.0.0' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
        },
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
  app.addSchema(ArtifactDeletionResultSchema);
  app.addSchema(ArtifactPermanentDeletionResultSchema);
  app.addSchema(TrashEmptyResultSchema);
  app.addSchema(withoutNestedSchemaIds(ArtifactRecoveryResultSchema));
  app.addSchema(RevisionComparisonSchema);
  app.addSchema(withoutNestedSchemaIds(ShareManagementSummarySchema));
  app.addSchema(withoutNestedSchemaIds(ArtifactDefaultSharesSchema));
  app.addSchema(withoutNestedSchemaIds(ShareCreateResultSchema));
  app.addSchema(withoutNestedSchemaIds(ShareCreateInputSchema));
  app.addSchema(withoutNestedSchemaIds(SharePageSchema));
  app.addSchema(withoutNestedSchemaIds(PublicShareResolutionSchema));
  app.addSchema(withoutNestedSchemaIds(ProtectedSessionEstablishInputSchema));
  app.addSchema(withoutNestedSchemaIds(ProtectedSessionAuthoritySchema));
  app.addSchema(withoutNestedSchemaIds(DashboardSessionSchema));
  app.addSchema(withoutNestedSchemaIds(DashboardCredentialPageSchema));
  app.addSchema(withoutNestedSchemaIds(DashboardCredentialIssueSchema));
  app.addSchema(withoutNestedSchemaIds(DashboardCredentialRevokeSchema));
  app.addSchema(WorkspaceCreateResultSchema);
  app.addSchema(WorkspaceDeleteResultSchema);
  app.addSchema(CommentPostSchema);
  app.addSchema(CommentThreadSchema);
  app.addSchema(CommentThreadPageSchema);
  app.addSchema(CommentSummarySchema);
  registerErrorHandler(app);
  await registerPublishRoute(app, dependencies, limits);
  await registerFolderRoutes(app, dependencies);
  await registerArtifactRoutes(app, dependencies);
  await registerRevisionRoutes(app, dependencies);
  await registerShareRoutes(app, dependencies);
  await registerCommentRoutes(app, dependencies);
  if (options.dashboardAccess !== undefined) {
    registerDashboardRoutes(app, {
      authenticator: dependencies.authenticator,
      access: options.dashboardAccess,
    });
  }
  registerPublicConfigRoute(app, options.rendererPublicOrigin);
  if (options.webRoot !== undefined) {
    await registerWebApp(app, {
      root: options.webRoot,
      ...(options.rendererPublicOrigin === undefined
        ? {}
        : { rendererOrigin: options.rendererPublicOrigin }),
    });
  }
  await app.ready();
  return app;
}
