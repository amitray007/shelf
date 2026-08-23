import { Readable } from 'node:stream';

import { COMPARISON_LIMITS, OpaqueRevisionIdSchema } from '@shelf/contracts';
import {
  type ContentByteRange,
  createReadRevisionService,
  createRevisionComparisonService,
  ShelfCoreError,
} from '@shelf/core';
import type { FastifyInstance } from 'fastify';
import { Type } from 'typebox';

import type { ShelfAppDependencies } from '../app.js';
import { authenticate } from '../authenticate.js';
import { deliverContent } from '../content-delivery.js';
import { requestCancellationSignal } from '../request-cancellation.js';

export const REVISION_CONTENT_ROUTE_URL = '/api/v1/revisions/:revisionId/content';
export const REVISION_PREVIEW_ROUTE_URL = '/api/v1/revisions/:revisionId/preview';
export const REVISION_COMPARISON_ROUTE_URL =
  '/api/v1/revisions/:baseRevisionId/comparisons/:targetRevisionId';

const ParamsSchema = Type.Object(
  {
    revisionId: OpaqueRevisionIdSchema,
  },
  { additionalProperties: false },
);

const ComparisonParamsSchema = Type.Object(
  {
    baseRevisionId: OpaqueRevisionIdSchema,
    targetRevisionId: OpaqueRevisionIdSchema,
  },
  { additionalProperties: false },
);

const ComparisonQuerySchema = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: COMPARISON_LIMITS.pageSize, default: 100 }),
    ),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

const HeadersSchema = Type.Object(
  {
    range: Type.Optional(
      Type.String({
        maxLength: 256,
        description: 'One RFC 9110 bytes range. Multiple ranges are not supported.',
      }),
    ),
    'if-none-match': Type.Optional(
      Type.String({ maxLength: 1024, description: 'Conditional entity tag validator.' }),
    ),
  },
  { additionalProperties: true },
);

const CommonDownloadResponseHeaders = {
  'Accept-Ranges': { type: 'string', description: 'Supported range unit; always bytes.' },
  'Content-Disposition': {
    type: 'string',
    description: 'Attachment disposition with safe ASCII and RFC 5987 UTF-8 file names.',
  },
  ETag: { type: 'string', description: 'Strong SHA-256 entity tag for this revision.' },
  'X-Content-Type-Options': {
    type: 'string',
    description: 'MIME-sniffing protection; always nosniff.',
  },
} as const;

const FullResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Complete immutable revision bytes, always delivered as an attachment.',
  }),
  headers: {
    ...CommonDownloadResponseHeaders,
    'Content-Length': { type: 'integer', description: 'Complete revision byte count.' },
  },
};

const PartialResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Selected immutable revision bytes, always delivered as an attachment.',
  }),
  headers: {
    ...CommonDownloadResponseHeaders,
    'Content-Length': { type: 'integer', description: 'Selected byte count.' },
    'Content-Range': { type: 'string', description: 'Inclusive byte range and full size.' },
  },
};

const NotModifiedResponseSchema = {
  ...Type.Null({ description: 'The entity tag matched; no bytes are returned.' }),
  headers: {
    'Accept-Ranges': { type: 'string', description: 'Supported range unit; always bytes.' },
    ETag: { type: 'string', description: 'Strong SHA-256 entity tag for this revision.' },
  },
};

const RangeErrorResponseSchema = {
  ...Type.Ref('ErrorEnvelope'),
  headers: {
    'Content-Range': {
      type: 'string',
      description: 'Unsatisfied range form: bytes */ followed by the full revision size.',
    },
  },
};

const PreviewResponseHeaders = {
  'Accept-Ranges': { type: 'string', description: 'Supported range unit; always bytes.' },
  'Content-Disposition': {
    type: 'string',
    description: 'Inline disposition with a safe file name.',
  },
  'Content-Length': { type: 'integer', description: 'Selected byte count.' },
  'Content-Range': { type: 'string', description: 'Inclusive byte range and full size.' },
  ETag: { type: 'string', description: 'Strong SHA-256 entity tag for this revision.' },
  'X-Content-Type-Options': {
    type: 'string',
    description: 'MIME-sniffing protection; always nosniff.',
  },
  'Content-Security-Policy': {
    type: 'string',
    description: 'Sandbox policy for inline active documents.',
  },
} as const;

const PreviewFullResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Complete immutable revision bytes delivered inline.',
  }),
  headers: PreviewResponseHeaders,
};

const PreviewPartialResponseSchema = {
  ...Type.String({
    format: 'binary',
    description: 'Selected immutable revision bytes delivered inline.',
  }),
  headers: PreviewResponseHeaders,
};

const PreviewNotModifiedResponseSchema = {
  ...Type.Null({ description: 'The entity tag matched; no bytes are returned.' }),
  headers: {
    'Accept-Ranges': { type: 'string', description: 'Supported range unit; always bytes.' },
    ETag: { type: 'string', description: 'Strong SHA-256 entity tag for this revision.' },
  },
};

const PreviewRangeErrorResponseSchema = {
  ...Type.Ref('ErrorEnvelope'),
  headers: {
    'Content-Range': {
      type: 'string',
      description: 'Unsatisfied range form: bytes */ followed by the full revision size.',
    },
  },
};

class RangeNotSatisfiableError extends ShelfCoreError {
  constructor() {
    super('RANGE_NOT_SATISFIABLE', 'The requested byte range is invalid or unsatisfiable.', {
      retryable: false,
      details: [{ field: 'range', reason: 'invalid or unsatisfiable single byte range' }],
    });
    this.name = 'RangeNotSatisfiableError';
  }
}

class MultiRangeUnsupportedError extends ShelfCoreError {
  constructor() {
    super('MULTI_RANGE_UNSUPPORTED', 'Multiple byte ranges are not supported.', {
      retryable: false,
      details: [{ field: 'range', reason: 'multiple byte ranges are unsupported' }],
    });
    this.name = 'MultiRangeUnsupportedError';
  }
}

function parseDecimal(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRange(value: string, size: number): ContentByteRange {
  if (/^bytes=/iu.test(value) && value.includes(',')) {
    throw new MultiRangeUnsupportedError();
  }
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value);
  if (match === null) throw new RangeNotSatisfiableError();
  const first = match[1] ?? '';
  const last = match[2] ?? '';
  if (first.length === 0 && last.length === 0) throw new RangeNotSatisfiableError();

  if (first.length === 0) {
    const suffixLength = parseDecimal(last);
    if (suffixLength === undefined || suffixLength === 0) throw new RangeNotSatisfiableError();
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = parseDecimal(first);
  const requestedEnd = last.length === 0 ? size - 1 : parseDecimal(last);
  if (start === undefined || requestedEnd === undefined || start >= size || requestedEnd < start) {
    throw new RangeNotSatisfiableError();
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function matchesEntityTag(value: string | undefined, entityTag: string): boolean {
  if (value === undefined) return false;
  const opaqueTag = entityTag.slice(1, -1);
  return value.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === '*') return true;
    const withoutWeakPrefix = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
    return withoutWeakPrefix === `"${opaqueTag}"`;
  });
}

function encodedFileName(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function attachmentDisposition(originalFileName: string, revisionId: string): string {
  const leaf = originalFileName.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  let unicodeName = Array.from(leaf)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim()
    .toWellFormed();
  if (unicodeName === '' || unicodeName === '.' || unicodeName === '..') {
    unicodeName = `revision-${revisionId}.bin`;
  }
  let asciiName = unicodeName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\;]/gu, '_');
  if (asciiName === '' || asciiName === '.' || asciiName === '..') {
    asciiName = `revision-${revisionId}.bin`;
  }
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedFileName(unicodeName)}`;
}

export async function registerRevisionRoutes(
  app: FastifyInstance,
  dependencies: ShelfAppDependencies,
): Promise<void> {
  const readRevision = createReadRevisionService(dependencies);
  const compareRevisions = createRevisionComparisonService({
    authorizer: dependencies.authorizer,
    revisions: dependencies.revisionRepository,
  });

  app.get(
    REVISION_COMPARISON_ROUTE_URL,
    {
      schema: {
        operationId: 'compareRevisionsV1',
        summary: 'Compare two immutable revisions of one artifact',
        description:
          'Compares immutable descriptors without opening content. Folder changes are paged; exact unambiguous byte matches identify moved files.',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['revisions'],
        params: ComparisonParamsSchema,
        querystring: ComparisonQuerySchema,
        response: {
          200: Type.Ref('RevisionComparison'),
          400: Type.Ref('ErrorEnvelope'),
          401: Type.Ref('ErrorEnvelope'),
          403: Type.Ref('ErrorEnvelope'),
          404: Type.Ref('ErrorEnvelope'),
          500: Type.Ref('ErrorEnvelope'),
          503: Type.Ref('ErrorEnvelope'),
        },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { baseRevisionId: string; targetRevisionId: string };
      const query = request.query as { limit?: number; cursor?: string };
      return compareRevisions({
        installationId: identity.installationId,
        actorId: identity.actorId,
        baseRevisionId: params.baseRevisionId,
        targetRevisionId: params.targetRevisionId,
        limit: query.limit ?? COMPARISON_LIMITS.pageSize,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        signal: requestCancellationSignal(request, reply),
      });
    },
  );

  app.get(
    REVISION_CONTENT_ROUTE_URL,
    {
      schema: {
        operationId: 'downloadRevisionContentV1',
        summary: 'Download one exact immutable revision',
        description:
          'Returns the pinned revision as an attachment. Supports validators and one bytes range.',
        produces: ['application/octet-stream'],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['revisions'],
        params: ParamsSchema,
        headers: HeadersSchema,
        response: {
          200: FullResponseSchema,
          206: PartialResponseSchema,
          304: NotModifiedResponseSchema,
          400: Type.Ref('ErrorEnvelope'),
          401: Type.Ref('ErrorEnvelope'),
          403: Type.Ref('ErrorEnvelope'),
          404: Type.Ref('ErrorEnvelope'),
          416: RangeErrorResponseSchema,
          500: Type.Ref('ErrorEnvelope'),
          503: Type.Ref('ErrorEnvelope'),
        },
      },
    },
    async (request, reply) => {
      const signal = requestCancellationSignal(request, reply);
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { revisionId: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const revision = await readRevision({
        installationId: identity.installationId,
        actorId: identity.actorId,
        revisionId: params.revisionId,
        signal,
      });
      const entityTag = `"${revision.contentHash}"`;

      reply.header('accept-ranges', 'bytes').header('etag', entityTag);

      if (matchesEntityTag(headers['if-none-match'], entityTag)) {
        return reply.status(304).send();
      }

      let range: ContentByteRange | undefined;
      if (headers.range !== undefined) {
        try {
          range = parseRange(headers.range, revision.byteCount);
        } catch (error) {
          if (
            error instanceof RangeNotSatisfiableError ||
            error instanceof MultiRangeUnsupportedError
          ) {
            reply.header('content-range', `bytes */${revision.byteCount}`);
          }
          throw error;
        }
      }

      const byteCount = range === undefined ? revision.byteCount : range.end - range.start + 1;
      const content = await revision.read(range);
      reply
        .header(
          'content-disposition',
          attachmentDisposition(revision.originalFileName, revision.revisionId),
        )
        .header('content-length', byteCount)
        .header('content-type', revision.mediaType)
        .header('x-content-type-options', 'nosniff');
      if (range !== undefined) {
        reply.header('content-range', `bytes ${range.start}-${range.end}/${revision.byteCount}`);
      }
      return reply.status(range === undefined ? 200 : 206).send(Readable.from(content));
    },
  );

  app.get(
    REVISION_PREVIEW_ROUTE_URL,
    {
      schema: {
        operationId: 'previewRevisionContentV1',
        summary: 'Preview one exact immutable revision inline',
        description:
          'Returns the stored media type inline. Supports validators and one RFC 9110 bytes range; active document types are sandboxed.',
        produces: ['application/octet-stream'],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: ['revisions'],
        params: ParamsSchema,
        headers: HeadersSchema,
        response: {
          200: PreviewFullResponseSchema,
          206: PreviewPartialResponseSchema,
          304: PreviewNotModifiedResponseSchema,
          400: Type.Ref('ErrorEnvelope'),
          401: Type.Ref('ErrorEnvelope'),
          403: Type.Ref('ErrorEnvelope'),
          404: Type.Ref('ErrorEnvelope'),
          416: PreviewRangeErrorResponseSchema,
          500: Type.Ref('ErrorEnvelope'),
          503: Type.Ref('ErrorEnvelope'),
        },
      },
    },
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const params = request.params as { revisionId: string };
      const headers = request.headers as { range?: string; 'if-none-match'?: string };
      const revision = await readRevision({
        installationId: identity.installationId,
        actorId: identity.actorId,
        revisionId: params.revisionId,
        signal: requestCancellationSignal(request, reply),
      });
      return deliverContent(
        reply,
        { range: headers.range, ifNoneMatch: headers['if-none-match'] },
        {
          mediaType: revision.mediaType,
          byteCount: revision.byteCount,
          contentHash: revision.contentHash,
          originalFileName: revision.originalFileName,
          read: (range) => revision.read(range),
        },
        { disposition: 'inline', fallbackFileName: `revision-${revision.revisionId}.bin` },
      );
    },
  );
}
