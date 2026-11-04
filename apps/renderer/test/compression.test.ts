import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  allowTransferCompression,
  isCompressibleMediaType,
  negotiateContentEncoding,
  registerResponseCompression,
} from '../src/compression.js';

const TEXT = 'Shelf compresses repetitive text on the wire. '.repeat(200);

async function fixture() {
  const app = Fastify();
  registerResponseCompression(app);
  app.get('/json', async () => ({ text: TEXT }));
  app.get('/small', async () => ({ ok: true }));
  app.get('/stream', async (_request, reply) =>
    reply
      .type('text/markdown')
      .header('content-length', Buffer.byteLength(TEXT))
      .header('etag', '"abc"')
      .send(Readable.from([Buffer.from(TEXT)])),
  );
  app.get('/partial', async (_request, reply) =>
    reply
      .status(206)
      .type('text/plain')
      .header('content-range', `bytes 0-9/${TEXT.length}`)
      .send(TEXT.slice(0, 10).repeat(200)),
  );
  app.get('/image', async (_request, reply) => reply.type('image/png').send(Buffer.alloc(4096, 1)));
  app.get('/download', async (_request, reply) => {
    allowTransferCompression(reply, 'text/csv');
    return reply.type('application/octet-stream').send(Buffer.from(TEXT));
  });
  await app.ready();
  return app;
}

describe('content encoding negotiation', () => {
  it('prefers Brotli, falls back to gzip, and honors refusals', () => {
    expect(negotiateContentEncoding('gzip, deflate, br, zstd')).toBe('br');
    expect(negotiateContentEncoding('gzip')).toBe('gzip');
    expect(negotiateContentEncoding('br;q=0, gzip')).toBe('gzip');
    expect(negotiateContentEncoding('br;q=0.2, gzip;q=0.8')).toBe('gzip');
    expect(negotiateContentEncoding('*')).toBe('br');
    expect(negotiateContentEncoding('*;q=0')).toBeUndefined();
    expect(negotiateContentEncoding('identity')).toBeUndefined();
    expect(negotiateContentEncoding(undefined)).toBeUndefined();
  });

  it('compresses text-like media only', () => {
    for (const type of [
      'text/html; charset=utf-8',
      'application/json',
      'application/vnd.api+json',
      'image/svg+xml',
      'application/javascript',
      'font/ttf',
    ])
      expect(isCompressibleMediaType(type), type).toBe(true);
    for (const type of [
      'image/png',
      'application/pdf',
      'font/woff2',
      'video/mp4',
      'application/zip',
    ])
      expect(isCompressibleMediaType(type), type).toBe(false);
  });
});

describe('response compression', () => {
  it('encodes serialized JSON with Brotli and keeps it decodable', async () => {
    const app = await fixture();
    const response = await app.inject({ url: '/json', headers: { 'accept-encoding': 'gzip, br' } });
    expect(response.headers['content-encoding']).toBe('br');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    expect(response.rawPayload.length).toBeLessThan(Buffer.byteLength(TEXT) / 10);
    expect(JSON.parse(brotliDecompressSync(response.rawPayload).toString())).toEqual({
      text: TEXT,
    });
  });

  it('leaves identity bodies alone for clients that do not ask', async () => {
    const app = await fixture();
    const response = await app.inject({ url: '/json' });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.json()).toEqual({ text: TEXT });
  });

  it('streams encoded content and weakens its validator', async () => {
    const app = await fixture();
    const response = await app.inject({ url: '/stream', headers: { 'accept-encoding': 'gzip' } });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers.etag).toBe('W/"abc"');
    expect(gunzipSync(response.rawPayload).toString()).toBe(TEXT);
  });

  it('never encodes partial content, tiny bodies, or binary media', async () => {
    const app = await fixture();
    for (const url of ['/partial', '/small', '/image']) {
      const response = await app.inject({ url, headers: { 'accept-encoding': 'br' } });
      expect(response.headers['content-encoding'], url).toBeUndefined();
    }
  });

  it('compresses an octet-stream download in transit when the stored file is text', async () => {
    const app = await fixture();
    const response = await app.inject({ url: '/download', headers: { 'accept-encoding': 'br' } });
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(response.rawPayload).toString()).toBe(TEXT);
  });

  it('adds Vary to HEAD responses without encoding them', async () => {
    const app = await fixture();
    const response = await app.inject({
      method: 'HEAD',
      url: '/json',
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});
