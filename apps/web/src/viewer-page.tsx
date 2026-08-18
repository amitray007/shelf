import { useEffect, useMemo } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';

import {
  establishProtectedSession,
  loadPublicClientConfig,
  loadViewerFileBytes,
  loadViewerFolderEntries,
  type PublicSharePayload,
  PublicShareUnavailableError,
  resolveViewerShare,
  type ViewerAuthority,
} from './api.js';
import {
  capabilityStorageKey,
  captureShareCapability,
  readOrCreateProtectedSessionId,
  readProtectedViewerToken,
  saveProtectedSessionAuthority,
  shareReferenceFromViewerPath,
  type ViewerShareReference,
} from './capability.js';
import { ArtifactContent } from './components/artifact-content.js';
import { ViewerRail } from './components/viewer-shell.js';
import { type PassiveRenderer, selectRenderer } from './rendering.js';
import {
  type FileShareResolution,
  isFileShareResolution,
  isFolderShareResolution,
} from './share-types.js';

interface PreparedFile {
  readonly renderer: PassiveRenderer;
  readonly text: string;
}

function prepareFile(
  resolution: FileShareResolution,
  bytes: ArrayBuffer | null,
  rendererOrigin: string | undefined,
): PreparedFile {
  const selected = selectRenderer(resolution.revision.mediaType, rendererOrigin);
  if (selected.kind !== 'text' && selected.kind !== 'json' && selected.kind !== 'markdown') {
    return { renderer: selected, text: '' };
  }
  if (bytes === null) return { renderer: { kind: 'download' }, text: '' };

  try {
    return { renderer: selected, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { renderer: { kind: 'download' }, text: '' };
  }
}

export async function viewerLoader({
  params,
  request,
}: LoaderFunctionArgs): Promise<PublicSharePayload> {
  const reference = shareReferenceFromViewerPath(`/s/${params.shareRef ?? ''}`);
  if (reference === null) throw new PublicShareUnavailableError();

  let authority: ViewerAuthority;
  if (reference.accessType === 'public') {
    authority = { accessType: 'public', publicCode: reference.publicCode };
  } else {
    const sessionId = readOrCreateProtectedSessionId(reference.shareId, window.sessionStorage);
    if (sessionId === null) throw new PublicShareUnavailableError();
    const token = readProtectedViewerToken(reference.shareId, window.sessionStorage);
    const secret =
      token === null
        ? captureShareCapability({
            shareId: reference.shareId,
            location: window.location,
            history: window.history,
            sessionStorage: window.sessionStorage,
          })
        : null;
    if (token === null && secret === null) throw new PublicShareUnavailableError();
    try {
      const established = await establishProtectedSession(
        reference.shareId,
        sessionId,
        token === null ? { secret: secret as string } : { token },
        request.signal,
      );
      saveProtectedSessionAuthority(window.sessionStorage, established);
      authority = {
        accessType: 'protected',
        shareId: established.shareId,
        sessionId: established.sessionId,
        token: established.token,
      };
    } catch (error) {
      if (
        token === null &&
        error instanceof PublicShareUnavailableError &&
        error.failure === 'terminal'
      ) {
        try {
          window.sessionStorage.removeItem(capabilityStorageKey(reference.shareId));
        } catch {
          // Terminal failures use the same unavailable projection even without writable storage.
        }
      }
      throw error;
    }
  }

  const config = await loadPublicClientConfig(request.signal);
  return loadViewerPayload(reference, authority, request.signal, config.rendererOrigin);
}

export async function loadViewerPayload(
  reference: ViewerShareReference,
  authority: ViewerAuthority,
  signal: AbortSignal | undefined,
  rendererOrigin: string | undefined,
): Promise<PublicSharePayload> {
  const resolution = await resolveViewerShare(reference, authority, signal);
  if (isFolderShareResolution(resolution)) {
    return {
      kind: 'folder',
      resolution,
      authority,
      entries: await loadViewerFolderEntries(resolution, authority, signal),
    };
  }
  if (!isFileShareResolution(resolution)) throw new PublicShareUnavailableError();
  const renderer = selectRenderer(resolution.revision.mediaType, rendererOrigin);
  const needsBytes = ['text', 'json', 'markdown', 'image'].includes(renderer.kind);
  return {
    kind: 'file',
    resolution,
    authority,
    bytes: needsBytes ? await loadViewerFileBytes(resolution, authority, signal) : null,
    ...(rendererOrigin === undefined ? {} : { rendererOrigin }),
  };
}

function FileArtifact({
  payload,
}: {
  readonly payload: Extract<PublicSharePayload, { kind: 'file' }>;
}) {
  const downloadUrl = useMemo(
    () =>
      payload.bytes === null ||
      selectRenderer(payload.resolution.revision.mediaType, payload.rendererOrigin).kind !== 'image'
        ? undefined
        : URL.createObjectURL(
            new Blob([payload.bytes], { type: payload.resolution.revision.mediaType }),
          ),
    [payload.bytes, payload.rendererOrigin, payload.resolution.revision.mediaType],
  );
  useEffect(
    () => () => {
      if (downloadUrl !== undefined) URL.revokeObjectURL(downloadUrl);
    },
    [downloadUrl],
  );

  const prepared = useMemo(
    () => prepareFile(payload.resolution, payload.bytes, payload.rendererOrigin),
    [payload.bytes, payload.rendererOrigin, payload.resolution],
  );
  return (
    <ArtifactContent
      {...(downloadUrl === undefined ? {} : { downloadUrl })}
      renderer={prepared.renderer}
      resolution={payload.resolution}
      authority={payload.authority}
      text={prepared.text}
    />
  );
}

export function ViewerPage() {
  const payload = useLoaderData() as PublicSharePayload;

  useEffect(() => {
    document.title = `${payload.resolution.artifact.name} · shelf`;
    return () => {
      document.title = 'shelf';
    };
  }, [payload.resolution.artifact.name]);

  return (
    <div className="viewer">
      <ViewerRail resolution={payload.resolution} />
      {payload.kind === 'file' ? (
        <FileArtifact payload={payload} />
      ) : (
        <ArtifactContent
          entries={payload.entries}
          authority={payload.authority}
          renderer={{ kind: 'download' }}
          resolution={payload.resolution}
        />
      )}
    </div>
  );
}
