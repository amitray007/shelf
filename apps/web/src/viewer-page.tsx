import { useEffect, useMemo } from 'react';
import type { LoaderFunctionArgs } from 'react-router';
import { useLoaderData } from 'react-router';

import {
  loadPublicClientConfig,
  loadPublicFileBytes,
  loadPublicFolderEntries,
  type PublicSharePayload,
  PublicShareUnavailableError,
  resolvePublicShare,
} from './api.js';
import { captureShareCapability, isShareId } from './capability.js';
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
  const shareId = params.shareId ?? '';
  if (!isShareId(shareId)) throw new PublicShareUnavailableError();

  const secret = captureShareCapability({
    shareId,
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
  });
  if (secret === null) throw new PublicShareUnavailableError();

  const config = await loadPublicClientConfig(request.signal);
  return loadViewerPayload(shareId, secret, request.signal, config.rendererOrigin);
}

export async function loadViewerPayload(
  shareId: string,
  secret: string,
  signal: AbortSignal | undefined,
  rendererOrigin: string | undefined,
): Promise<PublicSharePayload> {
  const resolution = await resolvePublicShare(shareId, secret, signal);
  if (isFolderShareResolution(resolution)) {
    return {
      kind: 'folder',
      resolution,
      entries: await loadPublicFolderEntries(resolution, secret, signal),
    };
  }
  if (!isFileShareResolution(resolution)) throw new PublicShareUnavailableError();
  const renderer = selectRenderer(resolution.revision.mediaType, rendererOrigin);
  const needsBytes = ['text', 'json', 'markdown', 'image'].includes(renderer.kind);
  return {
    kind: 'file',
    resolution,
    bytes: needsBytes ? await loadPublicFileBytes(resolution, secret, signal) : null,
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
          renderer={{ kind: 'download' }}
          resolution={payload.resolution}
        />
      )}
    </div>
  );
}
