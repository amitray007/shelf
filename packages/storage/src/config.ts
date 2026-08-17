import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { LocalContentStorage } from './local.js';
import { S3ContentStorage } from './s3.js';
import type { ContentStorage } from './types.js';

export interface LocalContentStorageConfig {
  driver: 'local';
  root: string;
}

export interface R2ContentStorageConfig {
  driver: 'r2';
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix?: string;
}

export type ContentStorageConfig = LocalContentStorageConfig | R2ContentStorageConfig;

function assertCredential(name: string, value: string): void {
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error(`Invalid R2 ${name}.`);
  }
}

export function createR2ContentStorage(config: R2ContentStorageConfig): S3ContentStorage {
  if (!/^[a-f0-9]{32}$/iu.test(config.accountId)) {
    throw new Error('Invalid R2 accountId.');
  }
  assertCredential('accessKeyId', config.accessKeyId);
  assertCredential('secretAccessKey', config.secretAccessKey);
  if (config.sessionToken !== undefined) assertCredential('sessionToken', config.sessionToken);

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId.toLowerCase()}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 10_000 }),
  });
  return new S3ContentStorage({
    client,
    bucket: config.bucket,
    ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
  });
}

export function createContentStorage(config: ContentStorageConfig): ContentStorage {
  switch (config.driver) {
    case 'local':
      return new LocalContentStorage({ root: config.root });
    case 'r2':
      return createR2ContentStorage(config);
  }
}
