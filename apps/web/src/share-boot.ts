import type { ProtectedSessionAuthority } from '@shelf/contracts';
import {
  establishProtectedSession,
  PublicShareUnavailableError,
  prepareViewerRendererConfig,
  resolveViewerShare,
  seedViewerInlineContent,
  type ViewerAuthority,
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
import { prefetchRendererModules } from './rendering.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

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
    if (sessionId === null) throw new PublicShareUnavailableError({ failure: 'terminal' });
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
  if (sessionId === null) throw new PublicShareUnavailableError({ failure: 'terminal' });
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

export async function prepareShareOpen(
  reference: ViewerShareReference,
  signal: AbortSignal,
  revisionId?: string,
) {
  let authority: ViewerAuthority;
  let initialResolution: FileShareResolution | FolderShareResolution | undefined;
  if (reference.accessType === 'public') {
    authority = { accessType: 'public', publicCode: reference.publicCode };
  } else {
    const established = await establishProtectedAuthority(reference.shareId, signal);
    authority = {
      accessType: 'protected',
      shareId: established.shareId,
      sessionId: established.sessionId,
      token: established.token,
    };
    if (
      revisionId === undefined &&
      established.resolution !== undefined &&
      (isFileShareResolution(established.resolution) ||
        isFolderShareResolution(established.resolution))
    ) {
      initialResolution = established.resolution;
    }
  }
  const config = prepareViewerRendererConfig(signal, reference.accessType === 'public');
  const resolution =
    initialResolution ?? (await resolveViewerShare(reference, authority, signal, revisionId));
  seedViewerInlineContent(resolution, authority);
  if (typeof window !== 'undefined') {
    prefetchRendererModules(
      isFolderShareResolution(resolution)
        ? { kind: 'folder' }
        : {
            kind: 'file',
            mediaType: resolution.revision.mediaType,
            originalFileName: resolution.revision.originalFileName,
          },
    );
  }
  return { authority, resolution, config };
}

type ShareOpen = Awaited<ReturnType<typeof prepareShareOpen>>;
let boot: { key: string; promise: Promise<ShareOpen>; controller: AbortController } | undefined;
function bootKey(url: URL): string {
  return `${url.pathname.replace(/\/$/, '')}?${url.searchParams.get('revision') ?? ''}`;
}

/** One navigation owns this work; never cache authority across route loads. */
export function startShareBoot(url: URL): void {
  const reference = shareReferenceFromViewerPath(url.pathname);
  if (reference === null) return;
  boot?.controller.abort();
  const controller = new AbortController();
  const promise = prepareShareOpen(
    reference,
    controller.signal,
    url.searchParams.get('revision') ?? undefined,
  );
  void promise.catch(() => undefined);
  boot = { key: bootKey(url), promise, controller };
}

export function consumeShareBoot(
  url: URL,
  signal: AbortSignal,
): Promise<ShareOpen | undefined> | undefined {
  const pending = boot;
  boot = undefined;
  if (pending === undefined) return undefined;
  if (pending.key !== bootKey(url)) {
    pending.controller.abort();
    return undefined;
  }
  return adoptShareBoot(pending, signal, url);
}

async function adoptShareBoot(
  pending: NonNullable<typeof boot>,
  signal: AbortSignal,
  url: URL,
): Promise<ShareOpen | undefined> {
  const abort = () => pending.controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await pending.promise;
  } catch (error) {
    signal.throwIfAborted();
    // A classified failure already spent its retry budget, and a terminal exchange erased
    // the secret on purpose. Only an unexpected boot fault starts over.
    if (error instanceof PublicShareUnavailableError || error instanceof IncompleteShareLinkError)
      throw error;
    const reference = shareReferenceFromViewerPath(url.pathname);
    if (reference === null) return undefined;
    return await prepareShareOpen(reference, signal, url.searchParams.get('revision') ?? undefined);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
