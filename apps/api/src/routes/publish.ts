import type { Multipart, MultipartFile } from '@fastify/multipart';
import type { PublisherMetadata } from '@shelf/contracts';
import {
  createPublishService,
  InvalidPublishRequestError,
  type PublishFileRequest,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';
import type { ShelfAppDependencies, ShelfMultipartLimits } from '../app.js';
import { authenticate } from '../authenticate.js';
import { requestCancellationSignal } from '../request-cancellation.js';

export const PUBLISH_ROUTE_URL = '/api/v1/workspaces/:workspaceId/artifacts';

export const PublishMultipartOpenApiSchema = Type.Object(
  {
    publisherMetadata: Type.Optional(
      Type.String({ description: 'JSON object of string values. Must precede the file part.' }),
    ),
    file: Type.Unsafe({ type: 'string', format: 'binary', isFile: true }),
  },
  { additionalProperties: false, required: ['file'] },
);

const ParamsSchema = Type.Object(
  { workspaceId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);

const HeadersSchema = Type.Object(
  {
    'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: true },
);

function invalid(field: string, reason: string): InvalidPublishRequestError {
  return new InvalidPublishRequestError([{ field, reason }]);
}

function parseMetadata(part: Exclude<Multipart, MultipartFile>): PublisherMetadata {
  if (part.valueTruncated) throw invalid('publisherMetadata', 'exceeds the field-size limit');
  if (typeof part.value !== 'string') throw invalid('publisherMetadata', 'must be JSON text');
  let parsed: unknown;
  try {
    parsed = JSON.parse(part.value);
  } catch {
    throw invalid('publisherMetadata', 'must be a JSON object of string values');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('publisherMetadata', 'must be a JSON object of string values');
  }
  return parsed as PublisherMetadata;
}

function translateMultipartError(error: unknown): never {
  if (error instanceof InvalidPublishRequestError) throw error;
  throw invalid('content', 'is malformed or violates the multipart upload limits');
}

async function nextPart(parts: AsyncIterator<Multipart>): Promise<IteratorResult<Multipart>> {
  try {
    return await parts.next();
  } catch (error) {
    return translateMultipartError(error);
  }
}

function streamedFile(
  file: MultipartFile,
  parts: AsyncIterator<Multipart>,
): AsyncIterable<Uint8Array> {
  return (async function* content() {
    try {
      for await (const chunk of file.file) yield chunk;
      if (file.file.truncated) throw invalid('content', 'exceeds the file-size limit');
      const extra = await nextPart(parts);
      if (!extra.done) {
        if (extra.value.type === 'file') {
          extra.value.file.resume();
          throw invalid('file', 'exactly one file part is allowed');
        }
        throw invalid(extra.value.fieldname, 'unexpected or duplicate multipart field');
      }
    } catch (error) {
      translateMultipartError(error);
    }
  })();
}

export async function registerPublishRoute(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
  limits: ShelfMultipartLimits,
): Promise<void> {
  const publish = createPublishService(dependencies);

  app.post(
    PUBLISH_ROUTE_URL,
    {
      config: { shelfMultipartBody: true, multipartOptions: { limits } },
      schema: {
        operationId: 'publishFileV1',
        summary: 'Publish one immutable file revision',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        tags: ['artifacts'],
        params: ParamsSchema,
        headers: HeadersSchema,
        response: {
          201: Type.Ref('PublishResult'),
          400: Type.Ref('ErrorEnvelope'),
          401: Type.Ref('ErrorEnvelope'),
          403: Type.Ref('ErrorEnvelope'),
          409: Type.Ref('ErrorEnvelope'),
          499: Type.Ref('ErrorEnvelope'),
          500: Type.Ref('ErrorEnvelope'),
          503: Type.Ref('ErrorEnvelope'),
        },
      },
    },
    async (request, reply) => {
      const signal = requestCancellationSignal(request, reply);
      const identity = await authenticate(request, dependencies.authenticator);
      if (!request.isMultipart()) throw invalid('content-type', 'must be multipart/form-data');

      const params = request.params as { workspaceId: string };
      const headers = request.headers as { 'idempotency-key': string };
      const parts = request.parts({ limits });
      let publisherMetadata: PublisherMetadata = {};
      let sawMetadata = false;
      let file: MultipartFile | undefined;

      while (file === undefined) {
        const item = await nextPart(parts);
        if (item.done) break;
        const part = item.value;
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume();
            throw invalid(part.fieldname, 'unexpected file part');
          }
          file = part;
          break;
        }
        if (part.fieldname !== 'publisherMetadata' || sawMetadata) {
          throw invalid(part.fieldname, 'unexpected or duplicate multipart field');
        }
        publisherMetadata = parseMetadata(part);
        sawMetadata = true;
      }
      if (file === undefined) throw invalid('file', 'exactly one file part is required');

      const input: PublishFileRequest = {
        installationId: identity.installationId,
        workspaceId: params.workspaceId,
        actorId: identity.actorId,
        requestId: request.id,
        idempotencyKey: headers['idempotency-key'],
        originalFileName: file.filename,
        mediaType: file.mimetype,
        publisherMetadata,
        content: streamedFile(file, parts),
        signal,
      };
      const result = await publish(input);
      return reply.status(201).send(result);
    },
  );
}
