import {
  type CommentAnchor,
  type CommentPost,
  type CommentThread,
  type CommentThreadPage,
  type FolderEntry,
  isCommentPost,
  isCommentThread,
  isFolderTreePage,
  isProtectedSessionAuthority,
  isPublicShareResolution,
  type ProtectedSessionAuthority,
} from '@shelf/contracts';

import type { ViewerShareReference } from './capability.js';
import { ContentCache } from './content-cache.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

const PROTECTED_ACTION = /^\/api\/v1\/public\/shares\/(shr_[A-Za-z0-9_-]{22})\/(content|tree)$/;
const PUBLIC_ACTION = /^\/api\/v1\/public\/links\/([A-Za-z0-9_-]{12})\/(content|tree)$/;
const viewerFolderContentCache = new ContentCache({ maxBytes: 16 * 1024 * 1024, maxEntries: 64 });

export type ViewerAuthority =
  | {
      readonly accessType: 'protected';
      readonly shareId: string;
      readonly sessionId: string;
      readonly token: string;
    }
  | { readonly accessType: 'public'; readonly publicCode: string };

export interface ViewerCommentContext {
  readonly resolution: FileShareResolution | FolderShareResolution;
  readonly authority: ViewerAuthority;
  readonly visitorToken?: string;
  readonly displayName?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

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

/** The Latest share advanced while this viewer was composing a comment. */
export class ViewerCommentRevisionMismatchError extends Error {
  constructor() {
    super(
      'This file was updated while you were writing. Your draft is still here; reload the latest revision and re-anchor it before posting.',
    );
    this.name = 'ViewerCommentRevisionMismatchError';
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
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      // Preserve the generic unavailable projection for non-JSON failures.
    }
    if (
      response.status === 400 &&
      typeof errorBody === 'object' &&
      errorBody !== null &&
      'error' in errorBody &&
      typeof errorBody.error === 'object' &&
      errorBody.error !== null &&
      'code' in errorBody.error &&
      errorBody.error.code === 'INVALID_REQUEST' &&
      'details' in errorBody.error &&
      Array.isArray(errorBody.error.details) &&
      errorBody.error.details.some(
        (detail: unknown) =>
          typeof detail === 'object' &&
          detail !== null &&
          'field' in detail &&
          detail.field === 'revisionId' &&
          'reason' in detail &&
          typeof detail.reason === 'string' &&
          detail.reason.includes('revision rendered by the shared link'),
      )
    ) {
      throw new ViewerCommentRevisionMismatchError();
    }
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

export async function loadViewerFolderEntryBytes(
  resolution: FolderShareResolution,
  authority: ViewerAuthority,
  path: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  viewerShareActionUrl(resolution, authority);
  // Session identity partitions protected bytes without retaining or keying on the
  // bearer token. Public codes are already the stable scope of a public link.
  const accessScope =
    authority.accessType === 'protected'
      ? `protected:${authority.shareId}:${authority.sessionId}`
      : `public:${authority.publicCode}`;
  return viewerFolderContentCache.getOrLoad(
    { accessScope, revisionId: resolution.revision.revisionId, folderPath: path },
    async (cacheSignal) => {
      const query = new URLSearchParams({ path });
      const url =
        authority.accessType === 'protected'
          ? `/api/v1/public/shares/${encodeURIComponent(authority.shareId)}/tree/content?${query}`
          : `/api/v1/public/links/${encodeURIComponent(authority.publicCode)}/tree/content?${query}`;
      const init =
        authority.accessType === 'protected'
          ? jsonPost({ token: authority.token }, cacheSignal)
          : { ...anonymousRequest(cacheSignal), method: 'GET' };
      const response = await anonymousFetch(url, init);
      if (!response.ok) throw new PublicShareUnavailableError();
      return response.arrayBuffer();
    },
    signal,
  );
}

function viewerCommentPrefix(authority: ViewerAuthority): string {
  return authority.accessType === 'protected'
    ? `/api/v1/public/shares/${encodeURIComponent(authority.shareId)}`
    : `/api/v1/public/links/${encodeURIComponent(authority.publicCode)}`;
}

function viewerCommentInit(
  authority: ViewerAuthority,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  method: 'POST' | 'PATCH' = 'POST',
): RequestInit {
  return {
    ...jsonPost(
      authority.accessType === 'protected' ? { token: authority.token, ...body } : body,
      signal,
    ),
    method,
  };
}

function requireCommentThread(value: unknown): CommentThread {
  if (!isCommentThread(value)) throw new PublicShareUnavailableError();
  return value;
}

function requireCommentPage(value: unknown): CommentThreadPage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    !value.items.every((item: unknown) => isCommentThread(item))
  ) {
    throw new PublicShareUnavailableError();
  }
  const nextCursor = 'nextCursor' in value ? value.nextCursor : undefined;
  if (typeof nextCursor !== 'string' && nextCursor !== null) {
    throw new PublicShareUnavailableError();
  }
  return { items: value.items as CommentThread[], nextCursor };
}

export async function loadViewerComments(
  context: ViewerCommentContext,
  signal?: AbortSignal,
): Promise<CommentThreadPage> {
  viewerShareActionUrl(context.resolution, context.authority);
  const currentRevisionId = context.resolution.revision.revisionId;
  const value = await responseJson(
    await anonymousFetch(
      `${viewerCommentPrefix(context.authority)}/comments/query`,
      viewerCommentInit(
        context.authority,
        {
          ...(context.visitorToken === undefined ? {} : { visitorToken: context.visitorToken }),
          currentRevisionId,
          ...(context.cursor === undefined ? {} : { cursor: context.cursor }),
          ...(context.limit === undefined ? {} : { limit: context.limit }),
        },
        signal,
      ),
    ),
  );
  return requireCommentPage(value);
}

export async function createViewerCommentThread(
  context: ViewerCommentContext & {
    readonly anchor: CommentAnchor;
    readonly body: string;
  },
  signal?: AbortSignal,
): Promise<CommentThread> {
  viewerShareActionUrl(context.resolution, context.authority);
  if (context.visitorToken === undefined || context.displayName === undefined) {
    throw new PublicShareUnavailableError({ failure: 'terminal' });
  }
  const value = await responseJson(
    await anonymousFetch(
      `${viewerCommentPrefix(context.authority)}/comments/threads`,
      viewerCommentInit(
        context.authority,
        {
          visitorToken: context.visitorToken,
          displayName: context.displayName,
          revisionId: context.anchor.revisionId,
          anchor: context.anchor,
          body: context.body,
        },
        signal,
      ),
    ),
  );
  return requireCommentThread(value);
}

export async function createViewerCommentReply(
  context: ViewerCommentContext & { readonly threadId: string; readonly body: string },
  signal?: AbortSignal,
): Promise<CommentPost> {
  viewerShareActionUrl(context.resolution, context.authority);
  if (context.visitorToken === undefined || context.displayName === undefined) {
    throw new PublicShareUnavailableError({ failure: 'terminal' });
  }
  const value = await responseJson(
    await anonymousFetch(
      `${viewerCommentPrefix(context.authority)}/comments/threads/${encodeURIComponent(context.threadId)}/replies`,
      viewerCommentInit(
        context.authority,
        {
          visitorToken: context.visitorToken,
          displayName: context.displayName,
          body: context.body,
        },
        signal,
      ),
    ),
  );
  if (!isCommentPost(value)) throw new PublicShareUnavailableError();
  return value;
}

export async function updateViewerCommentThread(
  context: ViewerCommentContext & {
    readonly threadId: string;
    readonly status: 'resolve' | 'reopen';
  },
  signal?: AbortSignal,
): Promise<CommentThread> {
  viewerShareActionUrl(context.resolution, context.authority);
  if (context.visitorToken === undefined || context.displayName === undefined) {
    throw new PublicShareUnavailableError({ failure: 'terminal' });
  }
  const value = await responseJson(
    await anonymousFetch(
      `${viewerCommentPrefix(context.authority)}/comments/threads/${encodeURIComponent(context.threadId)}`,
      viewerCommentInit(
        context.authority,
        {
          visitorToken: context.visitorToken,
          displayName: context.displayName,
          status: context.status,
        },
        signal,
        'PATCH',
      ),
    ),
  );
  return requireCommentThread(value);
}

export async function updateViewerCommentPost(
  context: ViewerCommentContext & {
    readonly postId: string;
    readonly action: 'edit' | 'delete';
    readonly body?: string;
  },
  signal?: AbortSignal,
): Promise<CommentPost> {
  viewerShareActionUrl(context.resolution, context.authority);
  if (context.visitorToken === undefined) {
    throw new PublicShareUnavailableError({ failure: 'terminal' });
  }
  const value = await responseJson(
    await anonymousFetch(
      `${viewerCommentPrefix(context.authority)}/comments/posts/${encodeURIComponent(context.postId)}`,
      viewerCommentInit(
        context.authority,
        {
          visitorToken: context.visitorToken,
          ...(context.displayName === undefined ? {} : { displayName: context.displayName }),
          action: context.action,
          ...(context.action === 'edit' && context.body !== undefined
            ? { body: context.body }
            : {}),
        },
        signal,
        'PATCH',
      ),
    ),
  );
  if (!isCommentPost(value)) throw new PublicShareUnavailableError();
  return value;
}
