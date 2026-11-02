import { pipeline, Readable, type Transform } from 'node:stream';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ContentEncoding = 'br' | 'gzip';

/** Bodies smaller than one packet gain nothing from compression. */
export const MIN_COMPRESSIBLE_BYTES = 1024;
/** Above this, streaming identity bytes keeps CPU bounded and range resumption available. */
export const MAX_COMPRESSIBLE_BYTES = 64 * 1024 * 1024;

const COMPRESSIBLE_APPLICATION_TYPES = new Set([
  'application/ecmascript',
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rtf',
  'application/sql',
  'application/toml',
  'application/wasm',
  'application/x-ndjson',
  'application/x-sh',
  'application/x-tex',
  'application/x-yaml',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
  'application/vnd.ms-fontobject',
  'font/otf',
  'font/ttf',
  'image/bmp',
  'image/svg+xml',
  'image/vnd.microsoft.icon',
  'image/x-icon',
]);

function essence(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/** Text-like media gains from transfer compression. Already compressed formats never do. */
export function isCompressibleMediaType(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const type = essence(mediaType);
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return COMPRESSIBLE_APPLICATION_TYPES.has(type);
}

/** Picks Brotli, then gzip, honoring explicit `q=0` refusals and the `*` wildcard. */
export function negotiateContentEncoding(
  header: string | readonly string[] | undefined,
): ContentEncoding | undefined {
  if (header === undefined) return undefined;
  const value = typeof header === 'string' ? header : header.join(',');
  const weights = new Map<string, number>();
  for (const part of value.toLowerCase().split(',')) {
    const [name = '', ...parameters] = part.trim().split(';');
    const coding = name.trim();
    if (coding === '') continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, raw] = parameter.trim().split('=');
      if (key?.trim() === 'q' && raw !== undefined) {
        const parsed = Number(raw.trim());
        quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
      }
    }
    weights.set(coding, quality);
  }
  const weight = (coding: ContentEncoding) => weights.get(coding) ?? weights.get('*') ?? 0;
  const br = weight('br');
  const gzip = weight('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return undefined;
}

/**
 * A streaming encoder tuned for on-the-fly delivery: Brotli quality 5 matches gzip's speed
 * while producing noticeably smaller text, which matters most on slow links.
 */
export function createContentEncoder(encoding: ContentEncoding, byteCount?: number): Transform {
  if (encoding === 'gzip') return createGzip({ level: 6 });
  return createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 5,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      ...(byteCount === undefined || byteCount <= 0
        ? {}
        : { [constants.BROTLI_PARAM_SIZE_HINT]: byteCount }),
    },
  });
}

function appendVary(reply: FastifyReply, field: string): void {
  const current = reply.getHeader('vary');
  const values =
    current === undefined
      ? []
      : String(Array.isArray(current) ? current.join(',') : current)
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== '');
  if (values.some((value) => value === '*' || value.toLowerCase() === field.toLowerCase())) return;
  void reply.header('vary', [...values, field].join(', '));
}

/** A compressed representation is no longer byte-identical, so its validator becomes weak. */
function weakenEntityTag(reply: FastifyReply): void {
  const tag = reply.getHeader('etag');
  if (typeof tag === 'string' && tag.startsWith('"')) void reply.header('etag', `W/${tag}`);
}

const compressionHints = new WeakMap<FastifyReply, string>();

/**
 * Lets a route that labels its body `application/octet-stream` (attachment downloads) still
 * compress it in transit when the stored media type is text-like. The browser decodes
 * transparently, so the saved file is unchanged.
 */
export function allowTransferCompression(reply: FastifyReply, storedMediaType: string): void {
  compressionHints.set(reply, storedMediaType);
}

function headerNumber(reply: FastifyReply, name: string): number | undefined {
  const value = reply.getHeader(name);
  if (value === undefined) return undefined;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isByteStream(payload: unknown): payload is Readable {
  return payload instanceof Readable;
}

/**
 * Decide whether this exact response can be compressed, adding `Vary` whenever the answer
 * depended on `Accept-Encoding` so shared caches never serve the wrong representation.
 */
export function selectResponseEncoding(
  request: FastifyRequest,
  reply: FastifyReply,
  byteCount: number | undefined,
): ContentEncoding | undefined {
  if (reply.statusCode !== 200) return undefined;
  if (reply.getHeader('content-encoding') !== undefined) return undefined;
  if (reply.getHeader('content-range') !== undefined) return undefined;
  const contentType = compressionHints.get(reply) ?? String(reply.getHeader('content-type') ?? '');
  if (!isCompressibleMediaType(contentType)) return undefined;
  appendVary(reply, 'Accept-Encoding');
  // HEAD advertises the same Vary as GET but carries no body to encode.
  if (request.method === 'HEAD') return undefined;
  if (
    byteCount !== undefined &&
    (byteCount < MIN_COMPRESSIBLE_BYTES || byteCount > MAX_COMPRESSIBLE_BYTES)
  )
    return undefined;
  return negotiateContentEncoding(request.headers['accept-encoding']);
}

/** Apply the response headers for an encoded body. The caller swaps in the encoded payload. */
export function markEncodedResponse(reply: FastifyReply, encoding: ContentEncoding): void {
  void reply.header('content-encoding', encoding);
  void reply.removeHeader('content-length');
  weakenEntityTag(reply);
}

function encodeBuffer(encoding: ContentEncoding, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const encoder = createContentEncoder(encoding, input.length);
    const chunks: Buffer[] = [];
    encoder.on('data', (chunk: Buffer) => chunks.push(chunk));
    encoder.once('error', reject);
    encoder.once('end', () => resolve(Buffer.concat(chunks)));
    encoder.end(input);
  });
}

/**
 * Compress text-like responses for clients that ask. Serialized JSON and HTML are encoded in
 * one step; streamed bodies are encoded as they flow, so the first byte is never delayed.
 */
export function registerResponseCompression(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'HEAD') {
      // Same Vary as GET, no body to encode.
      selectResponseEncoding(request, reply, undefined);
      return payload;
    }
    if (payload === null || payload === undefined) return payload;
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
      const encoding = selectResponseEncoding(request, reply, body.length);
      if (encoding === undefined) return payload;
      const encoded = await encodeBuffer(encoding, body);
      if (encoded.length >= body.length) return payload;
      markEncodedResponse(reply, encoding);
      void reply.header('content-length', encoded.length);
      return encoded;
    }
    if (isByteStream(payload)) {
      const encoding = selectResponseEncoding(
        request,
        reply,
        headerNumber(reply, 'content-length'),
      );
      if (encoding === undefined) return payload;
      markEncodedResponse(reply, encoding);
      const encoder = createContentEncoder(encoding, headerNumber(reply, 'content-length'));
      // pipeline() tears down both sides when the client disconnects or storage fails.
      return pipeline(payload, encoder, () => undefined);
    }
    return payload;
  });
}
