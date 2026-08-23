import { Readable } from 'node:stream';

import type { ContentByteRange } from '@shelf/core';
import { ShelfCoreError } from '@shelf/core';
import type { FastifyReply } from 'fastify';

export class RangeNotSatisfiableError extends ShelfCoreError {
  constructor() {
    super('RANGE_NOT_SATISFIABLE', 'The requested byte range is invalid or unsatisfiable.', {
      retryable: false,
      details: [{ field: 'range', reason: 'invalid or unsatisfiable single byte range' }],
    });
    this.name = 'RangeNotSatisfiableError';
  }
}

export class MultiRangeUnsupportedError extends ShelfCoreError {
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

/** Parse the RFC 9110 single `bytes` range form used by revision delivery. */
export function parseByteRange(value: string, size: number): ContentByteRange {
  if (size < 1) throw new RangeNotSatisfiableError();
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

export function matchesEntityTag(value: string | undefined, entityTag: string): boolean {
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

function safeFileName(originalFileName: string, fallback: string): string {
  const leaf = originalFileName.replace(/\\/gu, '/').split('/').at(-1) ?? '';
  const unicodeName = Array.from(leaf)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim()
    .toWellFormed();
  if (unicodeName === '' || unicodeName === '.' || unicodeName === '..') return fallback;
  return unicodeName;
}

export function contentDisposition(
  originalFileName: string,
  fallback: string,
  mode: 'inline' | 'attachment',
): string {
  const unicodeName = safeFileName(originalFileName, fallback);
  let asciiName = unicodeName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\;]/gu, '_');
  if (asciiName === '' || asciiName === '.' || asciiName === '..') asciiName = fallback;
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodedFileName(unicodeName)}`;
}

export interface DeliverableContent {
  mediaType: string;
  byteCount: number;
  contentHash: string;
  originalFileName: string;
  read(range?: ContentByteRange): Promise<AsyncIterable<Uint8Array>>;
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function requiresInlineSandbox(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  return (
    normalized === 'image/svg+xml' ||
    normalized === 'text/html' ||
    normalized === 'text/xml' ||
    normalized === 'application/xml' ||
    normalized.endsWith('+xml')
  );
}

/**
 * Deliver immutable content with one range, an entity validator, and a caller-selected
 * disposition. The caller must authenticate and resolve the descriptor before calling this.
 */
export async function deliverContent(
  reply: FastifyReply,
  request: {
    range?: string | undefined;
    ifNoneMatch?: string | undefined;
  },
  content: DeliverableContent,
  options: { disposition: 'inline' | 'attachment'; fallbackFileName: string },
) {
  const entityTag = `"${content.contentHash}"`;
  reply.header('accept-ranges', 'bytes').header('etag', entityTag);

  if (matchesEntityTag(request.ifNoneMatch, entityTag)) {
    return reply.status(304).send();
  }

  let range: ContentByteRange | undefined;
  if (request.range !== undefined) {
    try {
      range = parseByteRange(request.range, content.byteCount);
    } catch (error) {
      if (
        error instanceof RangeNotSatisfiableError ||
        error instanceof MultiRangeUnsupportedError
      ) {
        reply.header('content-range', `bytes */${content.byteCount}`);
      }
      throw error;
    }
  }

  const byteCount = range === undefined ? content.byteCount : range.end - range.start + 1;
  const source = await content.read(range);
  reply
    .type(content.mediaType)
    .header(
      'content-disposition',
      contentDisposition(content.originalFileName, options.fallbackFileName, options.disposition),
    )
    .header('content-length', byteCount)
    .header('x-content-type-options', 'nosniff');
  // Inline active documents must not gain script or navigation authority on the API origin.
  if (options.disposition === 'inline' && requiresInlineSandbox(content.mediaType)) {
    reply.header('content-security-policy', 'sandbox');
  }
  if (range !== undefined) {
    reply.header('content-range', `bytes ${range.start}-${range.end}/${content.byteCount}`);
  }
  return reply.status(range === undefined ? 200 : 206).send(Readable.from(source));
}
