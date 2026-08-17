import { type FolderEntry, isFolderTreePage, isPublicShareResolution } from '@shelf/contracts';

import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

const PUBLIC_SHARE_PATH = /^\/api\/v1\/public\/shares\/shr_[A-Za-z0-9_-]{22}\/(?:content|tree)$/;

export interface PublicFilePayload {
  readonly kind: 'file';
  readonly resolution: FileShareResolution;
  readonly bytes: ArrayBuffer | null;
  readonly rendererOrigin?: string;
}

export interface PublicFolderPayload {
  readonly kind: 'folder';
  readonly resolution: FolderShareResolution;
  readonly entries: readonly FolderEntry[];
}

export type PublicSharePayload = PublicFilePayload | PublicFolderPayload;

export class PublicShareUnavailableError extends Error {
  constructor() {
    super('Public artifact unavailable');
    this.name = 'PublicShareUnavailableError';
  }
}

export async function loadPublicClientConfig(
  signal?: AbortSignal,
): Promise<{ readonly rendererOrigin?: string }> {
  try {
    const response = await fetch('/api/v1/public/config', {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      ...(signal === undefined ? {} : { signal }),
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

function requestInit(secret: string, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    ...(signal === undefined ? {} : { signal }),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new PublicShareUnavailableError();
  try {
    return await response.json();
  } catch {
    throw new PublicShareUnavailableError();
  }
}

export function publicShareActionUrl(path: string, cursor?: string): string {
  if (!PUBLIC_SHARE_PATH.test(path)) throw new PublicShareUnavailableError();
  if (cursor === undefined) return path;
  const query = new URLSearchParams({ limit: '100', cursor });
  return `${path}?${query.toString()}`;
}

export async function resolvePublicShare(
  shareId: string,
  secret: string,
  signal?: AbortSignal,
): Promise<FileShareResolution | FolderShareResolution> {
  const resolutionValue = await responseJson(
    await fetch(
      `/api/v1/public/shares/${encodeURIComponent(shareId)}/resolve`,
      requestInit(secret, signal),
    ),
  );
  if (!isPublicShareResolution(resolutionValue)) throw new PublicShareUnavailableError();
  if (isFileShareResolution(resolutionValue) || isFolderShareResolution(resolutionValue)) {
    return resolutionValue;
  }
  throw new PublicShareUnavailableError();
}

export async function loadPublicFileBytes(
  resolution: FileShareResolution,
  secret: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(
    publicShareActionUrl(resolution.action.path),
    requestInit(secret, signal),
  );
  if (!response.ok) throw new PublicShareUnavailableError();
  return response.arrayBuffer();
}

export async function loadPublicFolderEntries(
  resolution: FolderShareResolution,
  secret: string,
  signal?: AbortSignal,
): Promise<readonly FolderEntry[]> {
  const entries: FolderEntry[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const pageValue = await responseJson(
      await fetch(
        publicShareActionUrl(resolution.action.path, cursor),
        requestInit(secret, signal),
      ),
    );
    if (!isFolderTreePage(pageValue) || pageValue.revisionId !== resolution.revision.revisionId) {
      throw new PublicShareUnavailableError();
    }
    entries.push(...pageValue.items);
    cursor = pageValue.nextCursor ?? undefined;
    if (entries.length > 2_000 || (cursor !== undefined && visitedCursors.has(cursor))) {
      throw new PublicShareUnavailableError();
    }
    if (cursor !== undefined) visitedCursors.add(cursor);
  } while (cursor !== undefined);
  return entries;
}
