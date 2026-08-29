import { useCallback, useEffect, useRef, useState } from 'react';

import type { ViewerAuthority } from '../api.js';
import type { PassiveRenderer } from '../rendering.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  shareRevisionAccess,
} from '../share-types.js';

type HtmlRenderer = Extract<PassiveRenderer, { kind: 'html' }>;
export type HtmlPreviewTheme = 'dark' | 'light';

export function RendererFrame({
  renderer,
  resolution,
  authority,
  path,
  theme,
}: {
  readonly renderer: HtmlRenderer;
  readonly resolution: FileShareResolution | FolderShareResolution;
  readonly authority: ViewerAuthority;
  readonly path?: string | undefined;
  readonly theme: HtmlPreviewTheme;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef<string>(window.crypto.randomUUID());
  const frameNameRef = useRef<string>(`shelf-renderer-${window.crypto.randomUUID()}`);
  const timeoutRef = useRef<number | undefined>(undefined);
  const loadGuardRef = useRef<number | undefined>(undefined);
  const channelRef = useRef<string | undefined>(undefined);
  const submittedRef = useRef(false);
  const rendererLoadSeenRef = useRef(false);
  const readyRef = useRef(false);
  const terminatedRef = useRef(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  const clearDeadline = useCallback(() => {
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    if (loadGuardRef.current !== undefined) window.clearTimeout(loadGuardRef.current);
    timeoutRef.current = undefined;
    loadGuardRef.current = undefined;
  }, []);

  const terminateFrame = useCallback(() => {
    if (terminatedRef.current) return;
    terminatedRef.current = true;
    clearDeadline();
    const frame = frameRef.current;
    if (frame !== null) frame.src = 'about:blank';
    setStatus('unavailable');
  }, [clearDeadline]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (terminatedRef.current) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== 'null') return;
      if (
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        !('nonce' in event.data) ||
        event.data.nonce !== nonceRef.current
      )
        return;
      if (event.data.type === 'shelf:renderer-armed') {
        if (
          'channel' in event.data &&
          typeof event.data.channel === 'string' &&
          /^[a-f0-9]{32}$/u.test(event.data.channel) &&
          channelRef.current === undefined
        ) {
          channelRef.current = event.data.channel;
        }
        return;
      }
      if (
        !('channel' in event.data) ||
        typeof event.data.channel !== 'string' ||
        event.data.channel !== channelRef.current
      )
        return;
      if (event.data.type === 'shelf:renderer-ready') {
        clearDeadline();
        readyRef.current = true;
        setStatus('ready');
      } else if (event.data.type === 'shelf:renderer-unavailable') {
        terminateFrame();
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      clearDeadline();
    };
  }, [clearDeadline, terminateFrame]);

  const submitRenderer = useCallback(() => {
    if (submittedRef.current || terminatedRef.current) return;
    const form = document.createElement('form');
    form.action = renderer.url;
    form.method = 'post';
    form.target = frameNameRef.current;
    form.hidden = true;

    const fields =
      authority.accessType === 'protected'
        ? { shareId: authority.shareId, viewerToken: authority.token, nonce: nonceRef.current }
        : { publicCode: authority.publicCode, nonce: nonceRef.current };
    for (const [name, value] of Object.entries({
      ...fields,
      ...(path === undefined ? {} : { path }),
      ...(resolution.target.mode === 'pinned' ||
      shareRevisionAccess(resolution) === 'shared-history'
        ? { revisionId: resolution.revision.revisionId }
        : {}),
    })) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }

    document.body.append(form);
    try {
      submittedRef.current = true;
      form.submit();
    } finally {
      form.remove();
    }
    clearDeadline();
    timeoutRef.current = window.setTimeout(terminateFrame, 8_000);
  }, [authority, clearDeadline, path, renderer.url, resolution, terminateFrame]);

  const stopPostReadyNavigation = useCallback(() => {
    if (terminatedRef.current) return;
    if (!submittedRef.current) {
      submitRenderer();
      return;
    }
    try {
      if (frameRef.current?.contentWindow?.location.href === 'about:blank') return;
    } catch {
      // The renderer document is cross-origin and intentionally unreadable.
    }
    if (rendererLoadSeenRef.current) {
      terminateFrame();
      return;
    }
    rendererLoadSeenRef.current = true;
    loadGuardRef.current = window.setTimeout(() => {
      if (!readyRef.current) terminateFrame();
    }, 250);
  }, [submitRenderer, terminateFrame]);

  useEffect(() => {
    submitRenderer();
  }, [submitRenderer]);

  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameRef.current = frame;
    frame?.setAttribute('credentialless', '');
  }, []);

  return (
    <div className="renderer-stage" data-status={status}>
      {status !== 'ready' && (
        <div className="renderer-status" role={status === 'unavailable' ? 'status' : undefined}>
          <span className="status-mark" aria-hidden="true" />
          <p>{status === 'loading' ? 'Opening isolated preview…' : 'Preview unavailable'}</p>
        </div>
      )}
      <iframe
        allow=""
        className="renderer-frame"
        data-preview-theme={theme}
        name={frameNameRef.current}
        onError={() => setStatus('unavailable')}
        onLoad={stopPostReadyNavigation}
        ref={attachFrame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src="about:blank"
        style={{ colorScheme: theme }}
        title={`${path ?? resolution.artifact.name} isolated preview`}
      />
    </div>
  );
}
