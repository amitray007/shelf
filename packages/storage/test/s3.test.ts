import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { S3ContentStorage } from '../src/index.js';

async function collectBody(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

class InMemoryS3RequestHandler {
  failPut = false;
  readonly objects = new Map<string, Buffer>();
  readonly objectModifiedAt = new Map<string, Date>();
  readonly multipart = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  readonly multipartInitiated = new Map<string, Date>();
  readonly requests: Array<{
    method: string;
    path: string;
    range?: string;
    query?: Record<string, string>;
  }> = [];

  async handle(request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
  }) {
    const key = decodeURIComponent(request.path.replace(/^\/test-bucket\//u, ''));
    this.requests.push({
      method: request.method,
      path: request.path,
      ...(request.headers.range === undefined ? {} : { range: request.headers.range }),
      ...(request.query === undefined ? {} : { query: request.query }),
    });

    if (request.method === 'HEAD' && request.path === '/test-bucket/') {
      return { response: { statusCode: 200, headers: {} } };
    }

    if (request.method === 'GET' && request.query?.['list-type'] === '2') {
      const prefix = request.query.prefix ?? '';
      const contents = [...this.objects.entries()]
        .filter(([objectKey]) => objectKey.startsWith(prefix))
        .map(
          ([objectKey, body]) =>
            `<Contents><Key>${objectKey}</Key><LastModified>${(this.objectModifiedAt.get(objectKey) ?? new Date()).toISOString()}</LastModified><Size>${body.byteLength}</Size></Contents>`,
        )
        .join('');
      const body = `<ListBucketResult><Name>test-bucket</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([body]),
        },
      };
    }

    if (request.method === 'GET' && request.query !== undefined && 'uploads' in request.query) {
      const prefix = request.query.prefix ?? '';
      const uploads = [...this.multipart.entries()]
        .filter(([, upload]) => upload.key.startsWith(prefix))
        .map(
          ([uploadId, upload]) =>
            `<Upload><Key>${upload.key}</Key><UploadId>${uploadId}</UploadId><Initiated>${(this.multipartInitiated.get(uploadId) ?? new Date()).toISOString()}</Initiated></Upload>`,
        )
        .join('');
      const body = `<ListMultipartUploadsResult><Bucket>test-bucket</Bucket><IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([body]),
        },
      };
    }

    if (request.method === 'POST' && request.query !== undefined && 'uploads' in request.query) {
      const uploadId = `upload-${this.multipart.size + 1}`;
      this.multipart.set(uploadId, { key, parts: new Map() });
      const body = `<CreateMultipartUploadResult><Bucket>test-bucket</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></CreateMultipartUploadResult>`;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([body]),
        },
      };
    }
    const uploadId = request.query?.uploadId;
    const partNumber = Number(request.query?.partNumber);
    if (request.method === 'PUT' && uploadId !== undefined && Number.isSafeInteger(partNumber)) {
      const upload = this.multipart.get(uploadId);
      if (upload === undefined) return { response: { statusCode: 404, headers: {} } };
      upload.parts.set(partNumber, await collectBody(request.body));
      return { response: { statusCode: 200, headers: { etag: `"part-${partNumber}"` } } };
    }
    if (request.method === 'POST' && uploadId !== undefined) {
      const upload = this.multipart.get(uploadId);
      if (upload === undefined) return { response: { statusCode: 404, headers: {} } };
      const complete = Buffer.concat(
        Array.from(upload.parts.entries())
          .sort(([left], [right]) => left - right)
          .map((entry) => entry[1]),
      );
      this.objects.set(upload.key, complete);
      this.objectModifiedAt.set(upload.key, new Date());
      this.multipart.delete(uploadId);
      this.multipartInitiated.delete(uploadId);
      const body = `<CompleteMultipartUploadResult><Bucket>test-bucket</Bucket><Key>${key}</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>`;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([body]),
        },
      };
    }
    if (request.method === 'PUT') {
      if (this.failPut) return { response: { statusCode: 500, headers: {} } };
      this.objects.set(key, await collectBody(request.body));
      this.objectModifiedAt.set(key, new Date());
      return { response: { statusCode: 200, headers: { etag: '"test-etag"' } } };
    }
    const object = this.objects.get(key);
    if (request.method === 'HEAD') {
      return object === undefined
        ? { response: { statusCode: 404, headers: {} } }
        : {
            response: { statusCode: 200, headers: { 'content-length': String(object.byteLength) } },
          };
    }
    if (request.method === 'GET' && object !== undefined) {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '');
      const start = match === null ? 0 : Number(match[1]);
      const end = match === null ? object.byteLength - 1 : Number(match[2]);
      const selected = object.subarray(start, end + 1);
      return {
        response: {
          statusCode: match === null ? 200 : 206,
          headers: {
            'content-length': String(selected.byteLength),
            ...(match === null
              ? {}
              : { 'content-range': `bytes ${start}-${end}/${object.byteLength}` }),
          },
          body: Readable.from([selected]),
        },
      };
    }
    if (request.method === 'DELETE') {
      this.objects.delete(key);
      this.objectModifiedAt.delete(key);
      return { response: { statusCode: 204, headers: {} } };
    }
    return { response: { statusCode: 404, headers: {} } };
  }
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const collected: Uint8Array[] = [];
  for await (const chunk of source) collected.push(chunk);
  return Buffer.concat(collected).toString('utf8');
}

describe('S3ContentStorage', () => {
  it('streams an opaque object, verifies it on seal, and maps exact range reads', async () => {
    const handler = new InMemoryS3RequestHandler();
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://storage.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      requestHandler: handler,
    });
    const storage = new S3ContentStorage({
      client,
      bucket: 'test-bucket',
      prefix: 'shelf-test',
    });
    await storage.ready();
    const staged = await storage.stage(chunks('hello ', 'r2'), {});
    const descriptor = {
      contentHash: 'sha256:fa5bcfe25165bf78117e5f29dc5ea28e38ca959b9be0387ea896fb911e4c01fa',
      byteCount: 8,
    };
    const sealed = await storage.seal(staged, descriptor);

    expect(sealed).toEqual({ contentId: staged.stageId, ...descriptor });
    await expect(collect(await storage.read(sealed, {}))).resolves.toBe('hello r2');
    await expect(
      collect(await storage.read(sealed, { range: { start: 6, end: 7 } })),
    ).resolves.toBe('r2');
    expect(handler.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'PUT', path: expect.stringContaining('/objects/cnt_') }),
        expect.objectContaining({ method: 'HEAD', path: expect.stringContaining('/objects/cnt_') }),
        expect.objectContaining({ method: 'GET', range: 'bytes=6-7' }),
      ]),
    );
  });

  it('uses bounded multipart upload for content larger than one configured part', async () => {
    const handler = new InMemoryS3RequestHandler();
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://storage.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      requestHandler: handler,
    });
    const storage = new S3ContentStorage({
      client,
      bucket: 'test-bucket',
      prefix: 'shelf-test',
      multipart: { partSize: 5 * 1024 * 1024, queueSize: 1 },
    });
    const value = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const staged = await storage.stage(
      (async function* content() {
        for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
          yield value.subarray(offset, Math.min(offset + 64 * 1024, value.byteLength));
        }
      })(),
      {},
    );
    const sealed = await storage.seal(staged, {
      contentHash: `sha256:${createHash('sha256').update(value).digest('hex')}`,
      byteCount: value.byteLength,
    });

    expect(handler.multipart).toHaveLength(0);
    const uploaded = handler.objects.get(`shelf-test/objects/${sealed.contentId}`);
    expect(uploaded).toHaveLength(value.byteLength);
    expect(
      createHash('sha256')
        .update(uploaded ?? Buffer.alloc(0))
        .digest('hex'),
    ).toBe(createHash('sha256').update(value).digest('hex'));
    expect(
      handler.requests.filter(
        (request) => request.method === 'PUT' && request.query?.partNumber !== undefined,
      ),
    ).toHaveLength(2);
  });

  it('best-effort deletes its opaque object when upload fails', async () => {
    const handler = new InMemoryS3RequestHandler();
    handler.failPut = true;
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://storage.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      requestHandler: handler,
    });
    const storage = new S3ContentStorage({ client, bucket: 'test-bucket' });

    await expect(storage.stage(chunks('failed upload'), {})).rejects.toThrow();
    expect(handler.requests.map((request) => request.method)).toContain('DELETE');
    expect(handler.objects).toHaveLength(0);
  });

  it('inventories completed objects and incomplete multipart staging without mutation', async () => {
    const handler = new InMemoryS3RequestHandler();
    const client = new S3Client({
      region: 'auto',
      endpoint: 'https://storage.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 1,
      requestHandler: handler,
    });
    const storage = new S3ContentStorage({
      client,
      bucket: 'test-bucket',
      prefix: 'shelf-test',
    });
    const completed = await storage.stage(chunks('complete'), {});
    const completedAt = new Date('2026-08-16T10:00:00.000Z');
    handler.objectModifiedAt.set(`shelf-test/objects/${completed.stageId}`, completedAt);
    const pendingId = 'cnt_99999999999999999999999999999999';
    const initiatedAt = new Date('2026-08-16T11:00:00.000Z');
    handler.multipart.set('pending-upload', {
      key: `shelf-test/objects/${pendingId}`,
      parts: new Map(),
    });
    handler.multipartInitiated.set('pending-upload', initiatedAt);

    await expect(storage.inventory()).resolves.toEqual({
      sealed: [{ contentId: completed.stageId, byteCount: 8, modifiedAt: completedAt }],
      staging: [{ stageId: pendingId, modifiedAt: initiatedAt }],
      unrecognizedEntries: 0,
    });
    expect(handler.objects).toHaveLength(1);
    expect(handler.multipart).toHaveLength(1);
  });
});
