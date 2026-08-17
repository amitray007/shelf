import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { ContentByteRange, SealedContent, StagedContent } from '@shelf/core';

import {
  assertDescriptor,
  assertSealedContent,
  assertStagedContent,
  createContentId,
  resolveContentRange,
} from './content-id.js';
import type { ContentStorage } from './types.js';

const DEFAULT_PREFIX = 'shelf';
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_QUEUE_SIZE = 2;

export interface S3ContentStorageOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
  multipart?: {
    partSize?: number;
    queueSize?: number;
  };
}

function normalizePrefix(value: string | undefined): string {
  const prefix = value ?? DEFAULT_PREFIX;
  if (
    prefix.length === 0 ||
    prefix.length > 512 ||
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.includes('//') ||
    prefix.split('/').some((segment) => segment === '.' || segment === '..') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(prefix)
  ) {
    throw new Error('Invalid S3 object prefix.');
  }
  return prefix;
}

function validateBucket(bucket: string): void {
  if (
    bucket.length === 0 ||
    bucket.length > 255 ||
    bucket.includes('/') ||
    bucket.includes('\\') ||
    Array.from(bucket).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Invalid S3 bucket.');
  }
}

function validateMultipart(options: S3ContentStorageOptions['multipart']): {
  partSize: number;
  queueSize: number;
} {
  const partSize = options?.partSize ?? DEFAULT_PART_SIZE;
  const queueSize = options?.queueSize ?? DEFAULT_QUEUE_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024) {
    throw new Error('S3 multipart partSize must be at least 5 MiB.');
  }
  if (!Number.isSafeInteger(queueSize) || queueSize < 1 || queueSize > 16) {
    throw new Error('S3 multipart queueSize must contain 1-16 workers.');
  }
  return { partSize, queueSize };
}

function isAsyncByteStream(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

/** S3-protocol adapter shared by R2 now and AWS-compatible providers after conformance testing. */
export class S3ContentStorage implements ContentStorage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #partSize: number;
  readonly #queueSize: number;

  constructor(options: S3ContentStorageOptions) {
    validateBucket(options.bucket);
    const multipart = validateMultipart(options.multipart);
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#prefix = normalizePrefix(options.prefix);
    this.#partSize = multipart.partSize;
    this.#queueSize = multipart.queueSize;
  }

  close(): void {
    this.#client.destroy();
  }

  async ready(): Promise<void> {
    await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
  }

  #key(contentId: string): string {
    return `${this.#prefix}/objects/${contentId}`;
  }

  async #delete(contentId: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(contentId) }),
    );
  }

  async stage(
    content: AsyncIterable<Uint8Array>,
    options: { signal?: AbortSignal },
  ): Promise<StagedContent> {
    options.signal?.throwIfAborted();
    const stageId = createContentId();
    const abortController = new AbortController();
    const upload = new Upload({
      client: this.#client,
      params: {
        Bucket: this.#bucket,
        Key: this.#key(stageId),
        Body: Readable.from(content, { objectMode: false }),
      },
      partSize: this.#partSize,
      queueSize: this.#queueSize,
      leavePartsOnError: false,
      abortController,
    });
    const abort = () => abortController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await upload.done();
      options.signal?.throwIfAborted();
      return { stageId };
    } catch (error) {
      await upload.abort().catch(() => undefined);
      await this.#delete(stageId).catch(() => undefined);
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async discard(staged: StagedContent): Promise<void> {
    assertStagedContent(staged);
    await this.#delete(staged.stageId);
  }

  async seal(
    staged: StagedContent,
    descriptor: { contentHash: string; byteCount: number },
  ): Promise<SealedContent> {
    assertStagedContent(staged);
    assertDescriptor(descriptor);
    const result = await this.#client.send(
      new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#key(staged.stageId) }),
    );
    if (result.ContentLength !== descriptor.byteCount) {
      throw new Error('Staged content size mismatch.');
    }
    return Object.freeze({ contentId: staged.stageId, ...descriptor });
  }

  async read(
    content: SealedContent,
    options: { range?: ContentByteRange; signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    options.signal?.throwIfAborted();
    assertSealedContent(content);
    const range = resolveContentRange(options.range, content.byteCount);
    const expectedLength = range.end - range.start + 1;
    const partial = options.range !== undefined;
    const result = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: this.#key(content.contentId),
        ...(partial ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
      options.signal === undefined ? undefined : { abortSignal: options.signal },
    );
    if (result.ContentLength !== expectedLength || !isAsyncByteStream(result.Body)) {
      throw new Error('Stored content response does not match the revision descriptor.');
    }
    if (
      partial &&
      result.ContentRange !== `bytes ${range.start}-${range.end}/${content.byteCount}`
    ) {
      throw new Error('Stored content range response does not match the requested range.');
    }
    return result.Body;
  }
}
