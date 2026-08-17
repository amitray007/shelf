import {
  PUBLISHER_METADATA_LIMITS,
  type PublisherMetadata,
  type PublishResult,
  RESERVED_PROVENANCE_KEYS,
} from '@shelf/contracts';
import { publishFile, type ShelfClientDependencies } from '../client.js';
import { usageFailure } from '../output.js';

export interface PublishCommandOptions {
  url: string;
  workspace: string;
  file: string;
  idempotencyKey: string;
  artifact?: string;
  metadata: readonly string[];
  allowInsecureLoopback?: boolean;
}

export function publisherMetadata(entries: readonly string[]): PublisherMetadata {
  if (entries.length > PUBLISHER_METADATA_LIMITS.maxKeys) {
    throw usageFailure('Too many publisher metadata entries.');
  }
  const metadata: PublisherMetadata = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const key = separator < 0 ? '' : entry.slice(0, separator);
    const value = separator < 0 ? '' : entry.slice(separator + 1);
    if (key.length === 0) throw usageFailure('Publisher metadata must use key=value syntax.');
    if (key.length > PUBLISHER_METADATA_LIMITS.maxKeyLength) {
      throw usageFailure('A publisher metadata key is too long.');
    }
    if (value.length > PUBLISHER_METADATA_LIMITS.maxValueLength) {
      throw usageFailure('A publisher metadata value is too long.');
    }
    if ((RESERVED_PROVENANCE_KEYS as readonly string[]).includes(key)) {
      throw usageFailure(`Publisher metadata key "${key}" is reserved.`);
    }
    if (Object.hasOwn(metadata, key))
      throw usageFailure(`Publisher metadata key "${key}" is duplicated.`);
    metadata[key] = value;
  }
  return metadata;
}

export async function executePublish(
  options: PublishCommandOptions,
  env: Readonly<Record<string, string | undefined>>,
  dependencies?: Partial<ShelfClientDependencies>,
): Promise<PublishResult> {
  const token = env.SHELF_TOKEN;
  if (token === undefined || token.length === 0) {
    throw usageFailure('SHELF_TOKEN is required.');
  }
  if (options.artifact !== undefined && !/^art_[A-Za-z0-9_-]{22}$/u.test(options.artifact)) {
    throw usageFailure('The artifact ID is invalid.');
  }
  return publishFile(
    {
      installationUrl: options.url,
      workspaceId: options.workspace,
      filePath: options.file,
      idempotencyKey: options.idempotencyKey,
      ...(options.artifact === undefined ? {} : { artifactId: options.artifact }),
      token,
      publisherMetadata: publisherMetadata(options.metadata),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    dependencies?.fetch === undefined && dependencies?.openFileBlob === undefined
      ? undefined
      : {
          fetch: dependencies.fetch ?? globalThis.fetch,
          openFileBlob:
            dependencies.openFileBlob ??
            (async (path) => {
              const { openAsBlob } = await import('node:fs');
              return openAsBlob(path);
            }),
        },
  );
}
