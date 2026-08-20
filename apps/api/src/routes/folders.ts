import { Readable } from 'node:stream';
import type { Multipart, MultipartFile, MultipartValue } from '@fastify/multipart';
import {
  FOLDER_LIMITS,
  FolderPublishResultSchema,
  FolderTreePageSchema,
  isFolderManifestInput,
  OpaqueArtifactIdSchema,
  OpaqueRevisionIdSchema,
  PortableFolderPathSchema,
  type PublisherMetadata,
} from '@shelf/contracts';
import {
  createFolderEntryContentService,
  createFolderPublishService,
  createFolderTreeService,
  InvalidPublishRequestError,
} from '@shelf/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies, ShelfMultipartLimits } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';

export const FOLDER_CREATE_ROUTE = '/api/v1/workspaces/:workspaceId/folders';
export const FOLDER_UPDATE_ROUTE = '/api/v1/workspaces/:workspaceId/folders/:artifactId/revisions';

export const FolderMultipartOpenApiSchema = Type.Object(
  {
    publisherMetadata: Type.Optional(
      Type.String({ description: 'JSON object of string values. Must precede file parts.' }),
    ),
    manifest: Type.String({
      description: 'shelf-folder-manifest/v1 JSON. Must precede every ordered file part.',
    }),
    file: Type.Array(Type.Unsafe({ type: 'string', format: 'binary', isFile: true }), {
      maxItems: FOLDER_LIMITS.maxFiles,
    }),
  },
  { additionalProperties: false, required: ['manifest'] },
);

export const FOLDER_MULTIPART_LIMITS: ShelfMultipartLimits = Object.freeze({
  fieldNameSize: 64,
  fieldSize: FOLDER_LIMITS.maxManifestBytes,
  fields: 2,
  fileSize: FOLDER_LIMITS.maxFileBytes,
  files: FOLDER_LIMITS.maxFiles,
  headerPairs: 64,
  parts: FOLDER_LIMITS.maxFiles + 2,
});

const CreateParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const UpdateParamsSchema = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    artifactId: OpaqueArtifactIdSchema,
  },
  { additionalProperties: false },
);
const RevisionParamsSchema = Type.Object(
  { revisionId: OpaqueRevisionIdSchema },
  { additionalProperties: false },
);
const HeadersSchema = Type.Object(
  { 'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: true },
);
const TreeQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FOLDER_LIMITS.treePageSize })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);
const EntryQuerySchema = Type.Object(
  { path: PortableFolderPathSchema },
  { additionalProperties: false },
);
const errorResponses = {
  400: Type.Ref('ErrorEnvelope'),
  401: Type.Ref('ErrorEnvelope'),
  403: Type.Ref('ErrorEnvelope'),
  404: Type.Ref('ErrorEnvelope'),
  409: Type.Ref('ErrorEnvelope'),
  499: Type.Ref('ErrorEnvelope'),
  500: Type.Ref('ErrorEnvelope'),
  503: Type.Ref('ErrorEnvelope'),
};

function invalid(field: string, reason: string): InvalidPublishRequestError {
  return new InvalidPublishRequestError([{ field, reason }]);
}

async function nextPart(parts: AsyncIterator<Multipart>): Promise<IteratorResult<Multipart>> {
  try {
    return await parts.next();
  } catch {
    throw invalid('content', 'is malformed or violates the folder multipart limits');
  }
}

function jsonField(part: MultipartValue, field: string): unknown {
  if (part.valueTruncated) throw invalid(field, 'exceeds the field-size limit');
  if (typeof part.value !== 'string') throw invalid(field, 'must be JSON text');
  try {
    return JSON.parse(part.value);
  } catch {
    throw invalid(field, 'must be valid JSON');
  }
}

function metadata(part: MultipartValue): PublisherMetadata {
  const value = jsonField(part, 'publisherMetadata');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('publisherMetadata', 'must be a JSON object of string values');
  }
  return value as PublisherMetadata;
}

function fileContent(file: MultipartFile): AsyncIterable<Uint8Array> {
  return (async function* content() {
    try {
      for await (const chunk of file.file) yield chunk;
      if (file.file.truncated)
        throw invalid(`files.${file.fieldname}`, 'exceeds the file-size limit');
    } catch (error) {
      if (error instanceof InvalidPublishRequestError) throw error;
      throw invalid('files', 'contains malformed file content');
    }
  })();
}

function orderedFiles(
  first: MultipartFile | undefined,
  parts: AsyncIterator<Multipart>,
): AsyncIterable<AsyncIterable<Uint8Array>> {
  return (async function* files() {
    let current: Multipart | undefined = first;
    while (current !== undefined) {
      if (current.type !== 'file') {
        throw invalid(current.fieldname, 'multipart fields must precede every file part');
      }
      if (current.fieldname !== 'file') {
        current.file.resume();
        throw invalid(current.fieldname, 'unexpected file part');
      }
      yield fileContent(current);
      const next = await nextPart(parts);
      current = next.done ? undefined : next.value;
    }
  })();
}

export async function registerFolderRoutes(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
): Promise<void> {
  const publish = createFolderPublishService({
    authorizer: dependencies.authorizer,
    artifactRepository: dependencies.revisionRepository,
    contentStore: dependencies.contentStore,
    folderRepository: dependencies.revisionRepository,
  });
  const tree = createFolderTreeService({
    authorizer: dependencies.authorizer,
    folders: dependencies.revisionRepository,
  });
  const readEntry = createFolderEntryContentService({
    authorizer: dependencies.authorizer,
    contentReader: dependencies.contentReader,
    folders: dependencies.revisionRepository,
  });

  const handler =
    (updatesArtifact: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const signal = requestCancellationSignal(request, reply);
      const identity = await authenticate(request, dependencies.authenticator);
      if (!request.isMultipart()) throw invalid('content-type', 'must be multipart/form-data');
      const params = request.params as { workspaceId: string; artifactId?: string };
      const headers = request.headers as { 'idempotency-key': string };
      const parts = request.parts({ limits: FOLDER_MULTIPART_LIMITS });
      let publisherMetadata: PublisherMetadata = {};
      let manifest: unknown;
      let firstFile: MultipartFile | undefined;
      let sawMetadata = false;
      let sawManifest = false;
      while (firstFile === undefined) {
        const item = await nextPart(parts);
        if (item.done) break;
        const part = item.value;
        if (part.type === 'file') {
          firstFile = part;
          break;
        }
        if (part.fieldname === 'publisherMetadata' && !sawMetadata) {
          publisherMetadata = metadata(part);
          sawMetadata = true;
          continue;
        }
        if (part.fieldname === 'manifest' && !sawManifest) {
          manifest = jsonField(part, 'manifest');
          sawManifest = true;
          continue;
        }
        throw invalid(part.fieldname, 'unexpected or duplicate multipart field');
      }
      if (!isFolderManifestInput(manifest)) {
        firstFile?.file.resume();
        throw invalid('manifest', 'must match shelf-folder-manifest/v1');
      }
      const result = await publish({
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        requestId: request.id,
        idempotencyKey: headers['idempotency-key'],
        ...(updatesArtifact && params.artifactId !== undefined
          ? { artifactId: params.artifactId }
          : {}),
        publisherMetadata,
        manifest,
        files: orderedFiles(firstFile, parts),
        signal,
      });
      return reply.status(201).send(result);
    };

  app.post(
    FOLDER_CREATE_ROUTE,
    {
      config: {
        shelfMultipartBody: 'folder',
        multipartOptions: { limits: FOLDER_MULTIPART_LIMITS },
      },
      schema: {
        operationId: 'publishFolderV1',
        summary: 'Publish one complete immutable folder snapshot',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['folders'],
        params: CreateParamsSchema,
        headers: HeadersSchema,
        response: { 201: FolderPublishResultSchema, ...errorResponses },
      },
    },
    handler(false),
  );
  app.post(
    FOLDER_UPDATE_ROUTE,
    {
      config: {
        shelfMultipartBody: 'folder',
        multipartOptions: { limits: FOLDER_MULTIPART_LIMITS },
      },
      schema: {
        operationId: 'publishFolderRevisionV1',
        summary: 'Publish another complete snapshot to one folder artifact',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['folders'],
        params: UpdateParamsSchema,
        headers: HeadersSchema,
        response: { 201: FolderPublishResultSchema, ...errorResponses },
      },
    },
    handler(true),
  );
  app.get(
    '/api/v1/revisions/:revisionId/tree',
    {
      schema: {
        operationId: 'getFolderTreeV1',
        summary: 'Page one immutable folder revision tree',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['folders'],
        params: RevisionParamsSchema,
        querystring: TreeQuerySchema,
        response: { 200: FolderTreePageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { revisionId: string };
      const query = request.query as { limit?: number; cursor?: string };
      return tree({
        installationId: identity.installationId,
        actorId: identity.actorId,
        revisionId: params.revisionId,
        limit: query.limit ?? FOLDER_LIMITS.treePageSize,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );
  app.get(
    '/api/v1/revisions/:revisionId/tree/content',
    {
      schema: {
        operationId: 'downloadFolderEntryContentV1',
        summary: 'Download one file from an immutable folder revision',
        produces: ['application/octet-stream'],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        params: RevisionParamsSchema,
        querystring: EntryQuerySchema,
        response: { 200: { type: 'string', format: 'binary' }, ...errorResponses },
      },
    },
    async (request, reply) => {
      const signal = requestCancellationSignal(request, reply);
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { revisionId: string };
      const query = request.query as { path: string };
      const file = await readEntry({
        installationId: identity.installationId,
        actorId: identity.actorId,
        revisionId: params.revisionId,
        path: query.path,
        signal,
      });
      return reply
        .type(file.mediaType)
        .header(
          'Content-Disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(query.path.split('/').at(-1) ?? 'file')}`,
        )
        .header('Content-Length', file.byteCount)
        .header('ETag', `"${file.contentHash}"`)
        .send(Readable.from(await file.read()));
    },
  );
}
