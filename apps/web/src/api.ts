import {
  type FolderEntry,
  isFolderTreePage,
  isProtectedSessionAuthority,
  isPublicShareResolution,
  type ProtectedSessionAuthority,
} from '@shelf/contracts';

import type { ViewerShareReference } from './capability.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

const PROTECTED_ACTION = /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/(content|tree)$/;
const PUBLIC_ACTION = /^\/api\/v1\/public\/links\/([A-Za-z0-9_-]{12})\/(content|tree)$/;

export type ViewerAuthority =
  | {
      readonly accessType: 'protected';
      readonly shareId: string;
      readonly sessionId: string;
      readonly token: string;
    }
  | { readonly accessType: 'public'; readonly publicCode: string };

export interface PublicFilePayload {
  readonly kind: 'file';
  readonly resolution: FileShareResolution;
  readonly authority: ViewerAuthority;
  readonly bytes: ArrayBuffer | null;
  readonly rendererOrigin?: string;
}

export interface PublicFolderPayload {
  readonly kind: 'folder';
  readonly resolution: FolderShareResolution;
  readonly authority: ViewerAuthority;
  readonly entries: readonly FolderEntry[];
}

export type PublicSharePayload = PublicFilePayload | PublicFolderPayload;

export type PublicShareFailure = 'terminal' | 'transient';

export class PublicShareUnavailableError extends Error {
  readonly failure: PublicShareFailure;

  constructor(options: { failure?: PublicShareFailure } = {}) {
    super('Public artifact unavailable');
    this.name = 'PublicShareUnavailableError';
    this.failure = options.failure ?? 'transient';
  }
}

const anonymousRequest = (signal?: AbortSignal): RequestInit => ({
  cache: 'no-store',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  ...(signal === undefined ? {} : { signal }),
});

function jsonPost(body: object, signal?: AbortSignal): RequestInit {
  return {
    ...anonymousRequest(signal),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function anonymousFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new PublicShareUnavailableError({ failure: 'transient' });
  }
}

function definitiveClientFailure(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429, 499].includes(status);
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new PublicShareUnavailableError({
      failure: definitiveClientFailure(response.status) ? 'terminal' : 'transient',
    });
  }
  try {
    return await response.json();
  } catch {
    throw new PublicShareUnavailableError({ failure: 'transient' });
  }
}

export async function loadPublicClientConfig(
  signal?: AbortSignal,
): Promise<{ readonly rendererOrigin?: string }> {
  try {
    const response = await anonymousFetch('/api/v1/public/config', {
      ...anonymousRequest(signal),
      method: 'GET',
    });
    const value: unknown = await responseJson(response);
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.keys(value).some((key) => key !== 'apiVersion' && key !== 'rendererOrigin') ||
      !('apiVersion' in value) ||
      value.apiVersion !== 'v1' ||
      !('rendererOrigin' in value) ||
      (value.rendererOrigin !== null && typeof value.rendererOrigin !== 'string')
    ) {
      return {};
    }
    return value.rendererOrigin === null ? {} : { rendererOrigin: value.rendererOrigin };
  } catch {
    return {};
  }
}

export async function establishProtectedSession(
  shareId: string,
  sessionId: string,
  authority: { readonly secret: string } | { readonly token: string },
  signal?: AbortSignal,
): Promise<ProtectedSessionAuthority> {
  const value = await responseJson(
    await anonymousFetch(
      `/api/v1/public/shares/${encodeURIComponent(shareId)}/sessions`,
      jsonPost({ sessionId, ...authority }, signal),
    ),
  );
  if (
    !isProtectedSessionAuthority(value) ||
    value.shareId !== shareId ||
    value.sessionId !== sessionId
  ) {
    throw new PublicShareUnavailableError();
  }
  return value;
}

export function viewerShareActionUrl(
  resolution: FileShareResolution | FolderShareResolution,
  authority: ViewerAuthority,
  cursor?: string,
): string {
  const match =
    authority.accessType === 'protected'
      ? PROTECTED_ACTION.exec(resolution.action.path)
      : PUBLIC_ACTION.exec(resolution.action.path);
  const expectedKind = resolution.action.type;
  const expectedReference =
    authority.accessType === 'protected' ? authority.shareId : authority.publicCode;
  if (
    resolution.accessType !== authority.accessType ||
    match === null ||
    match[1] !== expectedReference ||
    match[2] !== expectedKind ||
    (authority.accessType === 'protected' && resolution.shareId !== authority.shareId) ||
    (authority.accessType === 'public' &&
      (resolution.accessType !== 'public' || resolution.publicCode !== authority.publicCode))
  ) {
    throw new PublicShareUnavailableError();
  }
  if (cursor === undefined) return resolution.action.path;
  const query = new URLSearchParams({ limit: '100', cursor });
  return `${resolution.action.path}?${query.toString()}`;
}

export async function resolveViewerShare(
  reference: ViewerShareReference,
  authority: ViewerAuthority,
  signal?: AbortSignal,
): Promise<FileShareResolution | FolderShareResolution> {
  if (reference.accessType !== authority.accessType) throw new PublicShareUnavailableError();
  const url =
    reference.accessType === 'protected'
      ? `/api/v1/public/shares/${encodeURIComponent(reference.shareId)}/resolve`
      : `/api/v1/public/links/${encodeURIComponent(reference.publicCode)}/resolve`;
  const init =
    authority.accessType === 'protected'
      ? jsonPost({ token: authority.token }, signal)
      : { ...anonymousRequest(signal), method: 'GET' };
  const value = await responseJson(await anonymousFetch(url, init));
  if (!isPublicShareResolution(value)) throw new PublicShareUnavailableError();
  if (value.accessType !== authority.accessType) throw new PublicShareUnavailableError();
  if (isFileShareResolution(value) || isFolderShareResolution(value)) return value;
  throw new PublicShareUnavailableError();
}

export async function loadViewerFileBytes(
  resolution: FileShareResolution,
  authority: ViewerAuthority,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = viewerShareActionUrl(resolution, authority);
  const init =
    authority.accessType === 'protected'
      ? jsonPost({ token: authority.token }, signal)
      : { ...anonymousRequest(signal), method: 'GET' };
  const response = await anonymousFetch(url, init);
  if (!response.ok) throw new PublicShareUnavailableError();
  return response.arrayBuffer();
}

export async function loadViewerFolderEntries(
  resolution: FolderShareResolution,
  authority: ViewerAuthority,
  signal?: AbortSignal,
): Promise<readonly FolderEntry[]> {
  const entries: FolderEntry[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = viewerShareActionUrl(resolution, authority, cursor);
    const init =
      authority.accessType === 'protected'
        ? jsonPost({ token: authority.token }, signal)
        : { ...anonymousRequest(signal), method: 'GET' };
    const value = await responseJson(await anonymousFetch(url, init));
    if (!isFolderTreePage(value) || value.revisionId !== resolution.revision.revisionId) {
      throw new PublicShareUnavailableError();
    }
    entries.push(...value.items);
    cursor = value.nextCursor ?? undefined;
    if (entries.length > 2_000 || (cursor !== undefined && visitedCursors.has(cursor))) {
      throw new PublicShareUnavailableError();
    }
    if (cursor !== undefined) visitedCursors.add(cursor);
  } while (cursor !== undefined);
  return entries;
}
