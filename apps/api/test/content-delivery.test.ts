import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { deliverContent } from '../src/content-delivery.js';

interface TestReply {
  readonly request: { readonly headers: Record<string, string | undefined> };
  header(name: string, value: string | number): TestReply;
  getHeader(name: string): string | undefined;
  type(value: string): TestReply;
  status(value: number): TestReply;
  send(value?: unknown): TestReply;
}

function captureReply(requestHeaders: Record<string, string | undefined> = {}): {
  readonly headers: Record<string, string>;
  readonly reply: FastifyReply;
  readonly status: () => number;
} {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  const reply: TestReply = {
    request: { headers: requestHeaders },
    header(name, value) {
      headers[name.toLowerCase()] = String(value);
      return reply;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    type(value) {
      headers['content-type'] = value;
      return reply;
    },
    status(value) {
      statusCode = value;
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { headers, reply: reply as unknown as FastifyReply, status: () => statusCode };
}

function content(mediaType: string, read: () => Promise<AsyncIterable<Uint8Array>>) {
  return {
    mediaType,
    byteCount: 5,
    contentHash: 'sha256:content',
    originalFileName: 'preview.bin',
    read,
  };
}

describe('deliverContent', () => {
  it.each([
    'TEXT/HTML; charset=utf-8',
    'application/xhtml+xml; charset=utf-8',
    'IMAGE/SVG+XML; charset=utf-8',
    'application/xml; version=1',
    'application/atom+xml; charset=utf-8',
    'text/xml; charset=utf-8',
  ])('sandboxes parameterized active XML media type %s', async (mediaType) => {
    const capture = captureReply();
    await deliverContent(
      capture.reply,
      {},
      content(mediaType, async function* () {
        yield Buffer.from('bytes');
      }),
      { disposition: 'inline', fallbackFileName: 'preview.bin' },
    );

    expect(capture.headers['content-security-policy']).toBe('sandbox');
  });

  it('does not add an active-document sandbox to passive media', async () => {
    const capture = captureReply();
    await deliverContent(
      capture.reply,
      {},
      content('application/pdf; charset=binary', async function* () {
        yield Buffer.from('bytes');
      }),
      { disposition: 'inline', fallbackFileName: 'preview.bin' },
    );

    expect(capture.headers['content-security-policy']).toBeUndefined();
  });

  it('returns 304 before range parsing or content reads after a matching validator', async () => {
    let reads = 0;
    const capture = captureReply();
    await deliverContent(
      capture.reply,
      { ifNoneMatch: 'W/"sha256:content"', range: 'bytes=0-1,3-4' },
      content('text/plain', async function* () {
        reads += 1;
        yield Buffer.from('bytes');
      }),
      { disposition: 'inline', fallbackFileName: 'preview.bin' },
    );

    expect(capture.status()).toBe(304);
    expect(reads).toBe(0);
    expect(capture.headers['content-range']).toBeUndefined();
  });

  it('lets browsers keep authorized bytes only with revalidation', async () => {
    const capture = captureReply();
    await deliverContent(
      capture.reply,
      {},
      content('text/plain', async function* () {
        yield Buffer.from('bytes');
      }),
      { disposition: 'inline', fallbackFileName: 'preview.bin' },
    );
    expect(capture.headers['cache-control']).toBe('private, no-cache');

    const notModified = captureReply();
    await deliverContent(
      notModified.reply,
      { ifNoneMatch: '"sha256:content"' },
      content('text/plain', async function* () {
        yield Buffer.from('bytes');
      }),
      { disposition: 'inline', fallbackFileName: 'preview.bin' },
    );
    expect(notModified.status()).toBe(304);
    expect(notModified.headers['cache-control']).toBe('private, no-cache');
  });

  it.each([
    ['"sha256:content"', 206],
    ['"sha256:older"', 200],
    ['W/"sha256:content"', 200],
    ['Tue, 01 Sep 2026 00:00:00 GMT', 200],
  ])('honors a range only when If-Range %s names this exact file', async (ifRange, status) => {
    const capture = captureReply({ 'if-range': ifRange });
    await deliverContent(
      capture.reply,
      { range: 'bytes=0-1' },
      content('application/octet-stream', async function* () {
        yield Buffer.from('bytes');
      }),
      { disposition: 'attachment', fallbackFileName: 'download.bin' },
    );
    expect(capture.status()).toBe(status);
    expect(capture.headers['content-length']).toBe(status === 206 ? '2' : '5');
  });
});
