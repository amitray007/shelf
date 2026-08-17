import type { Artifact, ArtifactPage, ArtifactRevisionPage } from '@shelf/contracts';

import { getArtifact, listArtifactRevisions, listArtifacts } from '../client.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

export interface ListArtifactsCommandOptions {
  url: string;
  workspace: string;
  limit?: string;
  cursor?: string;
  allowInsecureLoopback?: boolean;
}

export interface ShowArtifactCommandOptions {
  url: string;
  artifact: string;
  allowInsecureLoopback?: boolean;
}

export interface ArtifactHistoryCommandOptions extends ShowArtifactCommandOptions {
  limit?: string;
  cursor?: string;
}

function token(runtime: CliRuntime): string {
  const value = runtime.env.SHELF_TOKEN;
  if (value === undefined || value.length === 0) throw usageFailure('SHELF_TOKEN is required.');
  return value;
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d+$/u.test(value)) throw usageFailure('The page limit is invalid.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw usageFailure('The page limit must be between 1 and 100.');
  }
  return parsed;
}

function artifactId(value: string): string {
  if (!/^art_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The artifact ID is invalid.');
  return value;
}

export function executeListArtifacts(
  options: ListArtifactsCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactPage> {
  return listArtifacts(
    {
      installationUrl: options.url,
      workspaceId: options.workspace,
      limit: pageLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeShowArtifact(
  options: ShowArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  return getArtifact(
    {
      installationUrl: options.url,
      artifactId: artifactId(options.artifact),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeArtifactHistory(
  options: ArtifactHistoryCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactRevisionPage> {
  return listArtifactRevisions(
    {
      installationUrl: options.url,
      artifactId: artifactId(options.artifact),
      limit: pageLimit(options.limit),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
