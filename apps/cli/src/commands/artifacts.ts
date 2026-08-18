import type {
  Artifact,
  ArtifactDeletionResult,
  ArtifactPage,
  ArtifactRevisionPage,
  RestoreResult,
} from '@shelf/contracts';

import {
  deleteArtifact,
  getArtifact,
  listArtifactRevisions,
  listArtifacts,
  recoverArtifact,
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
  sort?: string;
  order?: string;
  allowInsecureLoopback?: boolean;
}

export interface ShowArtifactCommandOptions {
  url: string;
  artifact: string;
  allowInsecureLoopback?: boolean;
}

export interface ArtifactHistoryCommandOptions extends ShowArtifactCommandOptions {
  limit?: string;
  order?: string;
  cursor?: string;
}

export interface RenameArtifactCommandOptions extends ShowArtifactCommandOptions {
  name: string;
}

export interface DeleteArtifactCommandOptions extends ShowArtifactCommandOptions {
  confirm: string;
}
export interface RecoverArtifactCommandOptions extends ShowArtifactCommandOptions {
  idempotencyKey?: string;
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

function artifactHistoryOrder(value: string | undefined): 'newest' | 'oldest' {
  if (value === undefined || value === 'newest') return 'newest';
  if (value === 'oldest') return 'oldest';
  throw usageFailure('The history order must be newest or oldest.');
}

function artifactSort(value: string | undefined): 'created' | 'updated' {
  if (value === undefined || value === 'updated') return 'updated';
  if (value === 'created') return 'created';
  throw usageFailure('Artifact sort must be created or updated.');
}

function artifactSortOrder(value: string | undefined): 'asc' | 'desc' {
  if (value === undefined || value === 'desc') return 'desc';
  if (value === 'asc') return 'asc';
  throw usageFailure('Artifact sort order must be asc or desc.');
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
      sort: artifactSort(options.sort),
      order: artifactSortOrder(options.order),
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
      order: artifactHistoryOrder(options.order),
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

export function executeDeleteArtifact(
  options: DeleteArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactDeletionResult> {
  const confirmedArtifactId = artifactId(options.artifact);
  if (options.confirm !== confirmedArtifactId) {
    throw usageFailure('The deletion confirmation must exactly match the artifact ID.');
  }
  return deleteArtifact(
    {
      installationUrl: options.url,
      artifactId: confirmedArtifactId,
      token: token(runtime),
      ...(options.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: options.allowInsecureLoopback }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export function executeRecoverArtifact(
  options: RecoverArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  const recoveryIdempotencyKey = idempotencyKey(
    options.idempotencyKey ?? `artifact-recover-${randomUUID()}`,
  );
  return recoverArtifact(
    {
      installationUrl: options.url,
      artifactId: artifactId(options.artifact),
      idempotencyKey: recoveryIdempotencyKey,
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

import { randomUUID } from 'node:crypto';
