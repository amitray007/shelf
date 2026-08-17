import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import {
  type Artifact,
  type ArtifactPage,
  type ArtifactRevisionPage,
  isArtifact,
  isArtifactPage,
  isArtifactRevisionPage,
  isErrorEnvelope,
  isPublishResult,
  isRestoreResult,
  type PublisherMetadata,
  type PublishResult,
  type RestoreResult,
} from '@shelf/contracts';
import { failure, remoteFailure, usageFailure } from './output.js';

export interface PublishFileOptions {
  installationUrl: string;
  workspaceId: string;
  filePath: string;
  idempotencyKey: string;
  artifactId?: string;
  token: string;
  publisherMetadata: PublisherMetadata;
  allowInsecureLoopback?: boolean;
}

export interface ShelfClientDependencies {
  fetch: typeof globalThis.fetch;
  openFileBlob: (path: string) => Promise<Blob>;
}

const defaultDependencies: ShelfClientDependencies = {
  fetch: globalThis.fetch,
  openFileBlob: (path) => openAsBlob(path),
};

export interface ListArtifactsOptions {
  installationUrl: string;
  workspaceId: string;
  limit: number;
  cursor?: string;
  token: string;
  allowInsecureLoopback?: boolean;
}

export interface GetArtifactOptions {
  installationUrl: string;
  artifactId: string;
  token: string;
  allowInsecureLoopback?: boolean;
}

export interface ListArtifactRevisionsOptions extends GetArtifactOptions {
  limit: number;
  cursor?: string;
}

export interface RenameArtifactOptions extends GetArtifactOptions {
  name: string;
}

export interface RestoreArtifactOptions extends GetArtifactOptions {
  workspaceId: string;
  sourceRevisionId: string;
  idempotencyKey: string;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  return Number(match[1]) === 127 && match.slice(1).every((octet) => Number(octet) <= 255);
}

function installationOrigin(raw: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageFailure('The installation URL is invalid.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw usageFailure(
      'The installation URL must not contain credentials, a query, or a fragment.',
    );
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw usageFailure('The installation URL must identify an origin without a path.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allowInsecureLoopback && isLoopback(url.hostname)) return url;
  throw usageFailure(
    url.protocol === 'http:'
      ? 'HTTP is allowed only for loopback development with --allow-insecure-loopback.'
      : 'The installation URL must use HTTPS.',
  );
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (Number.isSafeInteger(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Response exceeds the supported size.');
      }
    }
    if (response.body === null) throw new Error('Response body is missing.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        totalBytes += item.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error('Response exceeds the supported size.');
        }
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(text);
  } catch {
    throw failure('INTERNAL_ERROR', 'Shelf returned an invalid JSON response.');
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function requestApiJson<T>(
  url: URL,
  options: {
    token: string;
    allowInsecureLoopback: boolean;
    method?: 'GET' | 'PATCH' | 'POST';
    body?: string;
    expectedStatus?: number;
    idempotencyKey?: string;
  },
  dependencies: Pick<ShelfClientDependencies, 'fetch'>,
  validate: (value: unknown) => value is T,
): Promise<T> {
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: options.method ?? 'GET',
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': options.idempotencyKey }),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch {
      throw failure('SERVICE_UNAVAILABLE', 'Shelf could not be reached.', { retryable: true });
    }
    if (redirectStatuses.has(response.status)) {
      await cancelResponseBody(response);
      const location = response.headers.get('location');
      if (location === null) throw failure('INTERNAL_ERROR', 'Shelf returned an invalid redirect.');
      if (redirects === 5) throw failure('INTERNAL_ERROR', 'Shelf returned too many redirects.');
      const redirected = new URL(location, url);
      installationOrigin(redirected.origin, options.allowInsecureLoopback);
      if (redirected.origin !== url.origin) {
        throw failure('INTERNAL_ERROR', 'Shelf refused a cross-origin credential redirect.');
      }
      url = redirected;
      continue;
    }
    const payload = await responseJson(response);
    if (response.status === (options.expectedStatus ?? 200)) {
      if (!validate(payload)) throw failure('INTERNAL_ERROR', 'Shelf returned an invalid result.');
      return payload;
    }
    if (isErrorEnvelope(payload)) throw remoteFailure(payload);
    throw failure('INTERNAL_ERROR', 'Shelf returned an invalid error response.');
  }
  throw failure('INTERNAL_ERROR', 'Shelf returned too many redirects.');
}

export async function listArtifacts(
  options: ListArtifactsOptions,
  dependencies: Pick<ShelfClientDependencies, 'fetch'> = defaultDependencies,
): Promise<ArtifactPage> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const origin = installationOrigin(options.installationUrl, allowInsecureLoopback);
  const url = new URL(
    `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/artifacts`,
    origin,
  );
  url.searchParams.set('limit', String(options.limit));
  if (options.cursor !== undefined) url.searchParams.set('cursor', options.cursor);
  return requestApiJson(
    url,
    { token: options.token, allowInsecureLoopback },
    dependencies,
    isArtifactPage,
  );
}

export async function getArtifact(
  options: GetArtifactOptions,
  dependencies: Pick<ShelfClientDependencies, 'fetch'> = defaultDependencies,
): Promise<Artifact> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const origin = installationOrigin(options.installationUrl, allowInsecureLoopback);
  const url = new URL(`/api/v1/artifacts/${encodeURIComponent(options.artifactId)}`, origin);
  return requestApiJson(
    url,
    { token: options.token, allowInsecureLoopback },
    dependencies,
    isArtifact,
  );
}

export async function renameArtifact(
  options: RenameArtifactOptions,
  dependencies: Pick<ShelfClientDependencies, 'fetch'> = defaultDependencies,
): Promise<Artifact> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const origin = installationOrigin(options.installationUrl, allowInsecureLoopback);
  const url = new URL(`/api/v1/artifacts/${encodeURIComponent(options.artifactId)}`, origin);
  return requestApiJson(
    url,
    {
      token: options.token,
      allowInsecureLoopback,
      method: 'PATCH',
      body: JSON.stringify({ name: options.name }),
    },
    dependencies,
    isArtifact,
  );
}

export async function restoreArtifact(
  options: RestoreArtifactOptions,
  dependencies: Pick<ShelfClientDependencies, 'fetch'> = defaultDependencies,
): Promise<RestoreResult> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const origin = installationOrigin(options.installationUrl, allowInsecureLoopback);
  const url = new URL(
    `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/artifacts/${encodeURIComponent(options.artifactId)}/restores`,
    origin,
  );
  return requestApiJson(
    url,
    {
      token: options.token,
      allowInsecureLoopback,
      method: 'POST',
      body: JSON.stringify({ sourceRevisionId: options.sourceRevisionId }),
      expectedStatus: 201,
      idempotencyKey: options.idempotencyKey,
    },
    dependencies,
    isRestoreResult,
  );
}

export async function listArtifactRevisions(
  options: ListArtifactRevisionsOptions,
  dependencies: Pick<ShelfClientDependencies, 'fetch'> = defaultDependencies,
): Promise<ArtifactRevisionPage> {
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const origin = installationOrigin(options.installationUrl, allowInsecureLoopback);
  const url = new URL(
    `/api/v1/artifacts/${encodeURIComponent(options.artifactId)}/revisions`,
    origin,
  );
  url.searchParams.set('limit', String(options.limit));
  if (options.cursor !== undefined) url.searchParams.set('cursor', options.cursor);
  return requestApiJson(
    url,
    { token: options.token, allowInsecureLoopback },
    dependencies,
    isArtifactRevisionPage,
  );
}

function publishUrl(origin: URL, workspaceId: string, artifactId?: string): URL {
  const workspacePath = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/artifacts`;
  return new URL(
    artifactId === undefined
      ? workspacePath
      : `${workspacePath}/${encodeURIComponent(artifactId)}/revisions`,
    origin,
  );
}

async function requestBody(options: PublishFileOptions, dependencies: ShelfClientDependencies) {
  let blob: Blob;
  try {
    blob = await dependencies.openFileBlob(options.filePath);
  } catch {
    throw usageFailure('The file cannot be read.');
  }
  const form = new FormData();
  if (Object.keys(options.publisherMetadata).length > 0) {
    form.append('publisherMetadata', JSON.stringify(options.publisherMetadata));
  }
  form.append('file', blob, basename(options.filePath));
  return form;
}

export async function publishFile(
  options: PublishFileOptions,
  dependencies: ShelfClientDependencies = defaultDependencies,
): Promise<PublishResult> {
  const origin = installationOrigin(
    options.installationUrl,
    options.allowInsecureLoopback ?? false,
  );
  let url = publishUrl(origin, options.workspaceId, options.artifactId);

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const body = await requestBody(options, dependencies);
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${options.token}`,
          'idempotency-key': options.idempotencyKey,
        },
        body,
      });
    } catch {
      throw failure('SERVICE_UNAVAILABLE', 'Shelf could not be reached.', { retryable: true });
    }

    if (redirectStatuses.has(response.status)) {
      await cancelResponseBody(response);
      const location = response.headers.get('location');
      if (location === null) throw failure('INTERNAL_ERROR', 'Shelf returned an invalid redirect.');
      if (redirects === 5) throw failure('INTERNAL_ERROR', 'Shelf returned too many redirects.');
      const redirected = new URL(location, url);
      installationOrigin(redirected.origin, options.allowInsecureLoopback ?? false);
      if (redirected.origin !== url.origin) {
        throw failure('INTERNAL_ERROR', 'Shelf refused a cross-origin credential redirect.');
      }
      url = redirected;
      continue;
    }

    const payload = await responseJson(response);
    if (response.status === 201) {
      if (!isPublishResult(payload)) {
        throw failure('INTERNAL_ERROR', 'Shelf returned an invalid publish result.');
      }
      return payload;
    }
    if (isErrorEnvelope(payload)) throw remoteFailure(payload);
    throw failure('INTERNAL_ERROR', 'Shelf returned an invalid error response.');
  }
  throw failure('INTERNAL_ERROR', 'Shelf returned too many redirects.');
}
