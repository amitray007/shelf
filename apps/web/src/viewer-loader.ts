import type { ProtectedSessionAuthority } from '@shelf/contracts';
import type { LoaderFunctionArgs } from 'react-router';

import {
  establishProtectedSession,
  loadPublicClientConfig,
  loadViewerFileBytes,
  loadViewerFolderPage,
  MAX_VIEWER_CACHED_BYTES,
  type PublicSharePayload,
  PublicShareUnavailableError,
  resolveViewerShare,
  type ViewerAuthority,
  viewerSharePreviewUrl,
} from './api.js';
import {
  captureShareCapability,
  forgetProtectedSessionAuthority,
  forgetShareCapability,
  IncompleteShareLinkError,
  protectedSessionStorage,
  readOrCreateProtectedSessionId,
  readProtectedViewerToken,
  saveProtectedSessionAuthority,
  shareReferenceFromViewerPath,
  type ViewerShareReference,
} from './capability.js';
import {
  isHtmlPreview,
  MAX_IMAGE_PREVIEW_BYTES,
  prefetchRendererModules,
  requiresClientBytes,
  selectRenderer,
  usesPreviewUrl,
} from './rendering.js';
import type { FileShareResolution, FolderShareResolution } from './share-types.js';
import { isFileShareResolution, isFolderShareResolution } from './share-types.js';

function preconnectRenderer(origin: string | undefined): void {
  if (origin === undefined || typeof document === 'undefined') return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return;
  if (
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="preconnect"]')].some(
      (link) => link.href === `${url.origin}/`,
    )
  )
    return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = url.origin;
  link.crossOrigin = 'anonymous';
  document.head.append(link);
}

function isTerminalUnavailable(error: unknown): boolean {
  return error instanceof PublicShareUnavailableError && error.failure === 'terminal';
}

// Renew this browser's stored session first. A rejected token falls back to a link secret
// opened in this tab, so a fresh copy of the link always recovers access.
async function establishProtectedAuthority(
  shareId: string,
  signal: AbortSignal,
): Promise<ProtectedSessionAuthority> {
  const durable = protectedSessionStorage();
  const token = readProtectedViewerToken(shareId, durable);
  let tokenRejection: unknown;
  if (token !== null) {
    const sessionId = readOrCreateProtectedSessionId(shareId, durable);
    if (sessionId === null) throw new PublicShareUnavailableError();
    try {
      const renewed = await establishProtectedSession(shareId, sessionId, { token }, signal);
      saveProtectedSessionAuthority(durable, renewed);
      forgetShareCapability(shareId, window.sessionStorage);
      return renewed;
    } catch (error) {
      if (!isTerminalUnavailable(error)) throw error;
      forgetProtectedSessionAuthority(shareId, durable);
      tokenRejection = error;
    }
  }

  const secret = captureShareCapability({
    shareId,
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
  });
  if (secret === null) {
    if (tokenRejection !== undefined) throw tokenRejection;
    throw new IncompleteShareLinkError();
  }
  const sessionId = readOrCreateProtectedSessionId(shareId, durable);
  if (sessionId === null) throw new PublicShareUnavailableError();
  try {
    const established = await establishProtectedSession(shareId, sessionId, { secret }, signal);
    saveProtectedSessionAuthority(durable, established);
    forgetShareCapability(shareId, window.sessionStorage);
    return established;
  } catch (error) {
    if (isTerminalUnavailable(error)) forgetShareCapability(shareId, window.sessionStorage);
    throw error;
  }
}

export async function viewerLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<PublicSharePayload> {
  const reference = shareReferenceFromViewerPath(`/s/${params.shareRef ?? ''}`);
  if (reference === null) throw new PublicShareUnavailableError();

  let authority: ViewerAuthority;
  let initialResolution: FileShareResolution | FolderShareResolution | undefined;
  if (reference.accessType === 'public') {
    authority = { accessType: 'public', publicCode: reference.publicCode };
  } else {
    const established = await establishProtectedAuthority(reference.shareId, request.signal);
    authority = {
      accessType: 'protected',
      shareId: established.shareId,
      sessionId: established.sessionId,
      token: established.token,
    };
    if (
      established.resolution !== undefined &&
      (isFileShareResolution(established.resolution) ||
        isFolderShareResolution(established.resolution))
    ) {
      initialResolution = established.resolution;
    }
  }

  // Public shares need resolution to identify HTML, so overlap config with that request.
  const config =
    reference.accessType === 'public'
      ? loadPublicClientConfig(request.signal)
      : () => loadPublicClientConfig(request.signal);
  const revisionId = new URL(request.url).searchParams.get('revision') ?? undefined;
  return loadViewerPayload(
    reference,
    authority,
    request.signal,
    config,
    revisionId,
    revisionId === undefined ? initialResolution : undefined,
  );
}

export async function loadViewerPayload(
  reference: ViewerShareReference,
  authority: ViewerAuthority,
  signal: AbortSignal | undefined,
  rendererConfig:
    | string
    | undefined
    | Promise<{ readonly rendererOrigin?: string }>
    | (() => Promise<{ readonly rendererOrigin?: string }>),
  revisionId?: string,
  initialResolution?: FileShareResolution | FolderShareResolution,
): Promise<PublicSharePayload> {
  const resolution =
    initialResolution ?? (await resolveViewerShare(reference, authority, signal, revisionId));
  if (isFolderShareResolution(resolution)) {
    // Begin the first tree page while the viewer UI chunk and renderer config load.
    void loadViewerFolderPage(resolution, authority, signal).catch(() => undefined);
    if (typeof window !== 'undefined') prefetchRendererModules({ kind: 'folder' });
    const config =
      typeof rendererConfig === 'string'
        ? { rendererOrigin: rendererConfig }
        : typeof rendererConfig === 'function'
          ? await rendererConfig()
          : await rendererConfig;
    const rendererOrigin = config?.rendererOrigin;
    preconnectRenderer(rendererOrigin);
    return {
      kind: 'folder',
      resolution,
      authority,
      ...(rendererOrigin === undefined ? {} : { rendererOrigin }),
    };
  }
  if (!isFileShareResolution(resolution)) throw new PublicShareUnavailableError();
  const config = isHtmlPreview(resolution.revision.mediaType, resolution.revision.originalFileName)
    ? typeof rendererConfig === 'string'
      ? { rendererOrigin: rendererConfig }
      : typeof rendererConfig === 'function'
        ? await rendererConfig()
        : await rendererConfig
    : undefined;
  const rendererOrigin = config?.rendererOrigin;
  preconnectRenderer(rendererOrigin);
  if (typeof window !== 'undefined') {
    prefetchRendererModules({
      kind: 'file',
      mediaType: resolution.revision.mediaType,
      originalFileName: resolution.revision.originalFileName,
    });
  }
  const renderer = selectRenderer(
    resolution.revision.mediaType,
    rendererOrigin,
    resolution.revision.originalFileName,
  );
  const needsBytes =
    requiresClientBytes(renderer) ||
    (renderer.kind === 'image' && resolution.revision.byteCount <= MAX_IMAGE_PREVIEW_BYTES);
  if (needsBytes && resolution.revision.byteCount <= MAX_VIEWER_CACHED_BYTES) {
    // The file view joins this request through ContentCache. A speculative failure retries there.
    void loadViewerFileBytes(resolution, authority, signal).catch(() => undefined);
  }
  const previewUrl =
    !needsBytes && usesPreviewUrl(renderer)
      ? viewerSharePreviewUrl(resolution, authority)
      : undefined;
  return {
    kind: 'file',
    resolution,
    authority,
    needsBytes,
    ...(previewUrl === undefined ? {} : { previewUrl }),
    ...(rendererOrigin === undefined ? {} : { rendererOrigin }),
  };
}
