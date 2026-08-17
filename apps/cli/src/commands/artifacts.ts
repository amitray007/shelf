import type { Artifact, ArtifactPage, ArtifactRevisionPage, RestoreResult } from '@shelf/contracts';

import {
  getArtifact,
  listArtifactRevisions,
  listArtifacts,
  renameArtifact,
  restoreArtifact,
} from '../client.js';
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

export interface RenameArtifactCommandOptions extends ShowArtifactCommandOptions {
  name: string;
}

export interface RestoreArtifactCommandOptions extends ShowArtifactCommandOptions {
  workspace: string;
  revision: string;
  idempotencyKey: string;
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

function revisionId(value: string): string {
  if (!/^rev_[A-Za-z0-9_-]{22}$/u.test(value)) throw usageFailure('The revision ID is invalid.');
  return value;
}

function idempotencyKey(value: string): string {
  if (value.length === 0 || value.length > 128) {
    throw usageFailure('The idempotency key is invalid.');
  }
  return value;
}

function artifactName(value: string): string {
  const name = value.trim();
  const hasControlCharacter = [...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (name.length === 0 || [...name].length > 255 || hasControlCharacter) {
    throw usageFailure('The artifact name is invalid.');
  }
  return name;
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

export function executeRenameArtifact(
  options: RenameArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  return renameArtifact(
    {
      installationUrl: options.url,
      artifactId: artifactId(options.artifact),
      name: artifactName(options.name),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeRestoreArtifact(
  options: RestoreArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<RestoreResult> {
  return restoreArtifact(
    {
      installationUrl: options.url,
      workspaceId: options.workspace,
      artifactId: artifactId(options.artifact),
      sourceRevisionId: revisionId(options.revision),
      idempotencyKey: idempotencyKey(options.idempotencyKey),
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
