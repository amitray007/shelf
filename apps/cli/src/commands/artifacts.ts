import { randomUUID } from 'node:crypto';

import type {
  Artifact,
  ArtifactDeletionResult,
  ArtifactPage,
  ArtifactPermanentDeletionResult,
  ArtifactRecoveryResult,
  ArtifactRevisionPage,
  RestoreResult,
  ShareManagementSummary,
  TrashEmptyResult,
  TrashedArtifact,
  TrashPage,
} from '@shelf/contracts';

import {
  deleteArtifact,
  emptyTrash,
  getArtifact,
  getTrashedArtifact,
  listArtifactRevisions,
  listArtifacts,
  listTrash,
  permanentlyDeleteArtifact,
  recoverArtifact,
  renameArtifact,
  resolveManagedShare,
  restoreArtifact,
  setArtifactRetention,
} from '../client.js';
import { resolveRemoteContext, resolveWorkspaceContext, transportFields } from '../context.js';
import { usageFailure } from '../output.js';
import type { CliRuntime } from '../runtime.js';

export interface ListArtifactsCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  limit?: string;
  cursor?: string;
  sort?: string;
  order?: string;
  search?: string;
  allowInsecureLoopback?: boolean;
}

export interface ShowArtifactCommandOptions {
  profile?: string;
  url?: string;
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

export interface PermanentlyDeleteArtifactCommandOptions extends ShowArtifactCommandOptions {
  confirm: string;
}

export interface EmptyTrashCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  confirm: string;
  allowInsecureLoopback?: boolean;
}

export interface SetArtifactRetentionCommandOptions extends ShowArtifactCommandOptions {
  workspace?: string;
  mode: string;
}

export interface ListTrashCommandOptions extends ListArtifactsCommandOptions {}

export interface ResolveArtifactCommandOptions {
  profile?: string;
  url?: string;
  workspace?: string;
  from: string;
  allowInsecureLoopback?: boolean;
}

export interface RestoreArtifactCommandOptions extends ShowArtifactCommandOptions {
  workspace?: string;
  revision: string;
  idempotencyKey: string;
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

export async function executeListArtifacts(
  options: ListArtifactsCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactPage> {
  const context = await resolveWorkspaceContext(options, runtime);
  return listArtifacts(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      limit: pageLimit(options.limit),
      sort: artifactSort(options.sort),
      order: artifactSortOrder(options.order),
      ...(options.search === undefined ? {} : { search: options.search }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeShowArtifact(
  options: ShowArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  const context = await resolveRemoteContext(options, runtime);
  return getArtifact(
    {
      ...transportFields(context),
      artifactId: artifactId(options.artifact),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeArtifactHistory(
  options: ArtifactHistoryCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactRevisionPage> {
  const context = await resolveRemoteContext(options, runtime);
  return listArtifactRevisions(
    {
      ...transportFields(context),
      artifactId: artifactId(options.artifact),
      limit: pageLimit(options.limit),
      order: artifactHistoryOrder(options.order),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeRenameArtifact(
  options: RenameArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  const context = await resolveRemoteContext(options, runtime);
  return renameArtifact(
    {
      ...transportFields(context),
      artifactId: artifactId(options.artifact),
      name: artifactName(options.name),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeDeleteArtifact(
  options: DeleteArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactDeletionResult> {
  const confirmedArtifactId = artifactId(options.artifact);
  if (options.confirm !== confirmedArtifactId) {
    throw usageFailure('The deletion confirmation must exactly match the artifact ID.');
  }
  const context = await resolveRemoteContext(options, runtime);
  return deleteArtifact(
    {
      ...transportFields(context),
      artifactId: confirmedArtifactId,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeRecoverArtifact(
  options: RecoverArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactRecoveryResult> {
  const recoveryIdempotencyKey = idempotencyKey(
    options.idempotencyKey ?? `artifact-recover-${randomUUID()}`,
  );
  const context = await resolveRemoteContext(options, runtime);
  return recoverArtifact(
    {
      ...transportFields(context),
      artifactId: artifactId(options.artifact),
      idempotencyKey: recoveryIdempotencyKey,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executePermanentlyDeleteArtifact(
  options: PermanentlyDeleteArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<ArtifactPermanentDeletionResult> {
  const confirmedArtifactId = artifactId(options.artifact);
  if (options.confirm !== confirmedArtifactId) {
    throw usageFailure('The permanent deletion confirmation must exactly match the artifact ID.');
  }
  const context = await resolveRemoteContext(options, runtime);
  return permanentlyDeleteArtifact(
    {
      ...transportFields(context),
      artifactId: confirmedArtifactId,
      confirmation: options.confirm,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeEmptyTrash(
  options: EmptyTrashCommandOptions,
  runtime: CliRuntime,
): Promise<TrashEmptyResult> {
  const context = await resolveWorkspaceContext(options, runtime);
  if (options.confirm !== context.workspaceId) {
    throw usageFailure('The Empty Trash confirmation must exactly match the workspace ID.');
  }
  return emptyTrash(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      confirmation: options.confirm,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeSetArtifactRetention(
  options: SetArtifactRetentionCommandOptions,
  runtime: CliRuntime,
): Promise<Artifact> {
  if (options.mode !== 'automatic' && options.mode !== 'keep') {
    throw usageFailure('Artifact retention mode must be automatic or keep.');
  }
  const context = await resolveWorkspaceContext(options, runtime);
  return setArtifactRetention(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      artifactId: artifactId(options.artifact),
      mode: options.mode,
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeListTrash(
  options: ListTrashCommandOptions,
  runtime: CliRuntime,
): Promise<TrashPage> {
  const context = await resolveWorkspaceContext(options, runtime);
  return listTrash(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      limit: pageLimit(options.limit),
      ...(options.search === undefined ? {} : { search: options.search }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeShowTrashedArtifact(
  options: ShowArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<TrashedArtifact> {
  const context = await resolveRemoteContext(options, runtime);
  return getTrashedArtifact(
    {
      ...transportFields(context),
      artifactId: artifactId(options.artifact),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

function shareSelector(value: string): { shareId: string } | { publicCode: string } {
  if (/^shr_[A-Za-z0-9_-]{22}$/u.test(value)) return { shareId: value };
  if (/^[A-Za-z0-9_-]{12}$/u.test(value)) return { publicCode: value };
  let url: URL;
  try {
    url = new URL(value, 'https://shelf.invalid');
  } catch {
    throw usageFailure('The share ID or link is invalid.');
  }
  const match = /^\/s\/([^/]+)$/u.exec(url.pathname);
  const selector = match?.[1];
  if (selector !== undefined && /^shr_[A-Za-z0-9_-]{22}$/u.test(selector)) {
    return { shareId: selector };
  }
  if (selector !== undefined && /^[A-Za-z0-9_-]{12}$/u.test(selector)) {
    return { publicCode: selector };
  }
  throw usageFailure('The share ID or link is invalid.');
}

export async function executeResolveArtifact(
  options: ResolveArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<ShareManagementSummary> {
  const context = await resolveWorkspaceContext(options, runtime);
  return resolveManagedShare(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      ...shareSelector(options.from),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}

export async function executeRestoreArtifact(
  options: RestoreArtifactCommandOptions,
  runtime: CliRuntime,
): Promise<RestoreResult> {
  const context = await resolveWorkspaceContext(options, runtime);
  return restoreArtifact(
    {
      ...transportFields(context),
      workspaceId: context.workspaceId,
      artifactId: artifactId(options.artifact),
      sourceRevisionId: revisionId(options.revision),
      idempotencyKey: idempotencyKey(options.idempotencyKey),
    },
    runtime.fetch === undefined ? undefined : { fetch: runtime.fetch },
  );
}
