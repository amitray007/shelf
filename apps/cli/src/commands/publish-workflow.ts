import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { FolderPublishResult, PublishResult, ShareCreateResult } from '@shelf/contracts';

import { createShare, publishFile } from '../client.js';
import { mediaTypeForPath } from '../media-type.js';
import {
  type JournalPublishResult,
  openPublishOperation,
  publishOperationFingerprint,
} from '../operation-journal.js';
import { CliFailure, CliPartialFailure, usageFailure } from '../output.js';
import { resolveProfile } from '../profiles.js';
import type { CliRuntime } from '../runtime.js';
import { executePublishFolderWithToken, prepareLocalFolder } from './folders.js';
import { publisherMetadata } from './publish.js';

export interface PublishWorkflowOptions {
  readonly path: string;
  readonly profile?: string;
  readonly artifact?: string;
  readonly metadata: readonly string[];
  readonly idempotencyKey?: string;
  readonly share?: boolean;
}

export interface PublishWorkflowResult {
  readonly apiVersion: 'v1';
  readonly operation: 'publish';
  readonly status: 'complete';
  readonly profile: string;
  readonly publish: PublishResult | FolderPublishResult;
  readonly share: ShareCreateResult | null;
  readonly urls: {
    readonly artifact: string;
    readonly revision: string;
    readonly share: string | null;
  };
}

export interface PublishWorkflowExecution {
  readonly output: PublishWorkflowResult;
  finalize(): Promise<void>;
}

function opaqueArtifactId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^art_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The artifact ID is invalid.');
  return value;
}

async function fileContentFingerprint(path: string, initial: Stats): Promise<string> {
  const fingerprint = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) fingerprint.update(chunk);
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.size !== initial.size ||
      current.mtimeMs !== initial.mtimeMs
    ) {
      throw new Error('changed');
    }
  } catch {
    throw usageFailure('The publish file changed while it was being inspected.');
  }
  return fingerprint.digest('hex');
}

export async function executePublishWorkflow(
  options: PublishWorkflowOptions,
  runtime: CliRuntime,
): Promise<PublishWorkflowExecution> {
  const profile = await resolveProfile(options.profile, runtime);
  let metadata: Stats;
  try {
    metadata = await lstat(options.path);
  } catch {
    throw usageFailure('The publish path cannot be read.');
  }
  if ((!metadata.isFile() && !metadata.isDirectory()) || metadata.isSymbolicLink()) {
    throw usageFailure('The publish path must identify a real file or directory, not a link.');
  }
  const artifactId = opaqueArtifactId(options.artifact);
  const metadataInput = publisherMetadata(options.metadata);
  const preparedFolder = metadata.isDirectory()
    ? await prepareLocalFolder(options.path)
    : undefined;
  const contentFingerprint =
    preparedFolder?.contentFingerprint ?? (await fileContentFingerprint(options.path, metadata));
  const fingerprint = publishOperationFingerprint({
    profile: profile.name,
    installationUrl: profile.installationUrl,
    workspaceId: profile.workspaceId,
    path: resolve(options.path),
    kind: metadata.isDirectory() ? 'folder' : 'file',
    artifactId: artifactId ?? null,
    metadata: Object.fromEntries(
      Object.entries(metadataInput).sort(([left], [right]) =>
        Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
      ),
    ),
    share: options.share ?? false,
    explicitIdempotencyKey: options.idempotencyKey ?? null,
    contentFingerprint,
  });
  const journal = await openPublishOperation(runtime.env, fingerprint);
  const idempotencyKey = options.idempotencyKey ?? journal.record.publishIdempotencyKey;
  let publish: JournalPublishResult;
  try {
    publish =
      journal.record.publish ??
      (metadata.isDirectory()
        ? await executePublishFolderWithToken(
            {
              url: profile.installationUrl,
              workspace: profile.workspaceId,
              directory: options.path,
              idempotencyKey,
              ...(artifactId === undefined ? {} : { artifact: artifactId }),
              metadata: options.metadata,
              allowInsecureLoopback: profile.allowInsecureLoopback,
            },
            runtime,
            profile.token,
            undefined,
            preparedFolder,
          )
        : await publishFile(
            {
              installationUrl: profile.installationUrl,
              workspaceId: profile.workspaceId,
              filePath: options.path,
              idempotencyKey,
              ...(artifactId === undefined ? {} : { artifactId }),
              token: profile.token,
              publisherMetadata: metadataInput,
              allowInsecureLoopback: profile.allowInsecureLoopback,
            },
            runtime.fetch === undefined
              ? undefined
              : {
                  fetch: runtime.fetch,
                  openFileBlob: async (path) => {
                    const { openAsBlob } = await import('node:fs');
                    return openAsBlob(path, { type: mediaTypeForPath(path) });
                  },
                },
          ));
  } catch (error) {
    if (error instanceof CliFailure && error.envelope.error.code === 'IDEMPOTENCY_CONFLICT') {
      await journal.complete();
    }
    throw error;
  }
  if (journal.record.publish === null) await journal.savePublish(publish);
  const origin = new URL(profile.installationUrl);
  const urls = {
    artifact: new URL(`/artifacts/${encodeURIComponent(publish.artifactId)}`, origin).href,
    revision: new URL(
      `/artifacts/${encodeURIComponent(publish.artifactId)}/revisions/${encodeURIComponent(publish.revisionId)}`,
      origin,
    ).href,
    share: null,
  } as const;
  let share: ShareCreateResult | null = null;
  if (options.share) {
    try {
      share = await createShare(
        {
          installationUrl: profile.installationUrl,
          workspaceId: profile.workspaceId,
          artifactId: publish.artifactId,
          target: { mode: 'latest' },
          expiresAt: null,
          idempotencyKey: journal.record.shareIdempotencyKey,
          token: profile.token,
          allowInsecureLoopback: profile.allowInsecureLoopback,
        },
        runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
      );
    } catch (error) {
      if (!(error instanceof CliFailure)) throw error;
      throw new CliPartialFailure(
        {
          apiVersion: 'v1',
          operation: 'publish',
          status: 'partial',
          profile: profile.name,
          publish,
          share: null,
          urls,
          error: error.envelope.error,
        },
        error,
        [profile.token],
      );
    }
  }
  const result: PublishWorkflowResult = {
    apiVersion: 'v1',
    operation: 'publish',
    status: 'complete',
    profile: profile.name,
    publish,
    share,
    urls: {
      artifact: urls.artifact,
      revision: urls.revision,
      share: share === null ? null : new URL(share.url, origin).href,
    },
  };
  return { output: result, finalize: journal.complete };
}
