import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';

import { deliverContent } from '../src/content-delivery.js';

interface TestReply {
  header(name: string, value: string | number): TestReply;
  type(value: string): TestReply;
  status(value: number): TestReply;
  send(value?: unknown): TestReply;
}

function captureReply(): {
  readonly headers: Record<string, string>;
  readonly reply: FastifyReply;
  readonly status: () => number;
} {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  const reply: TestReply = {
    header(name, value) {
      headers[name.toLowerCase()] = String(value);
      return reply;
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
});
