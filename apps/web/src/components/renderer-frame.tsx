import { useCallback, useEffect, useRef, useState } from 'react';

import type { ViewerAuthority } from '../api.js';
import type { PassiveRenderer } from '../rendering.js';
import {
  type FileShareResolution,
  type FolderShareResolution,
  shareRevisionAccess,
} from '../share-types.js';
import { ArtifactLoadingState } from './boot-views.js';

type HtmlRenderer = Extract<PassiveRenderer, { kind: 'html' }>;
export type HtmlPreviewTheme = 'dark' | 'light';

interface RendererFrameProps {
  readonly renderer: HtmlRenderer;
  readonly resolution: FileShareResolution | FolderShareResolution;
  readonly authority: ViewerAuthority;
  readonly path?: string | undefined;
  readonly theme: HtmlPreviewTheme;
  /** A fragment from the folder link that opened this file, applied when the document loads. */
  readonly fragment?: string | undefined;
  /** Opens a same-folder file after the rendered document asks for one through a link. */
  readonly onOpenPath?: ((path: string, fragment: string) => void) | undefined;
}

export function RendererFrame(props: RendererFrameProps) {
  // Set the scheme before authored scripts run. Updating a live frame can trigger
  // a page's theme-change reload handler, which the navigation guard must block.
  return <RecoveringRenderer key={props.theme} {...props} />;
}

function RecoveringRenderer(props: RendererFrameProps) {
  const [attempt, setAttempt] = useState(0);
  const started = useRef(Date.now());
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const recover = useCallback(() => {
    const delay = [300, 600, 1200, 2400][attempt];
    if (
      timer.current !== undefined ||
      delay === undefined ||
      Date.now() - started.current + delay >= 10_000
    )
      return;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setAttempt((value) => value + 1);
    }, delay);
  }, [attempt]);
  return (
    <RendererDocument
      key={attempt}
      {...props}
      onRecover={recover}
      deadline={started.current + 10_000}
    />
  );
}

function RendererDocument({
  renderer,
  resolution,
  authority,
  path,
  theme,
  fragment,
  onOpenPath,
  onRecover,
  deadline,
}: RendererFrameProps & { readonly onRecover: () => void; readonly deadline: number }) {
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
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

  const recoverFrame = useCallback(() => {
    if (terminatedRef.current) return;
    terminateFrame();
    onRecover();
  }, [onRecover, terminateFrame]);

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
        if ('retryable' in event.data && event.data.retryable === true) recoverFrame();
        else terminateFrame();
      } else if (
        event.data.type === 'shelf:renderer-open-path' &&
        readyRef.current &&
        'path' in event.data &&
        typeof event.data.path === 'string' &&
        event.data.path.length <= 4096
      ) {
        const linkedFragment =
          'fragment' in event.data &&
          typeof event.data.fragment === 'string' &&
          event.data.fragment.length <= 1024
            ? event.data.fragment
            : '';
        onOpenPathRef.current?.(event.data.path, linkedFragment);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      clearDeadline();
    };
  }, [clearDeadline, recoverFrame, terminateFrame]);

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
      ...(path === undefined || fragment === undefined || fragment === '' ? {} : { fragment }),
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
    // Armed is posted before authored scripts; ready follows DOMContentLoaded, so slow
    // images and fonts never hold the frame hidden. The recovery budget caps the wait.
    timeoutRef.current = window.setTimeout(
      recoverFrame,
      Math.min(8_000, Math.max(0, deadline - Date.now())),
    );
  }, [authority, clearDeadline, deadline, fragment, path, renderer.url, resolution, recoverFrame]);

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
    // A completed document with no bootstrap signal is an error page. An armed
    // document keeps its full readiness allowance instead of this short message grace.
    loadGuardRef.current = window.setTimeout(() => {
      if (!readyRef.current && channelRef.current === undefined) recoverFrame();
    }, 250);
  }, [submitRenderer, terminateFrame, recoverFrame]);

  useEffect(() => {
    submitRenderer();
  }, [submitRenderer]);

  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    frameRef.current = frame;
    frame?.setAttribute('credentialless', '');
  }, []);

  return (
    <div className="renderer-stage" data-status={status}>
      {status === 'loading' ? (
        // Match the boot loader so a fresh load reads as one continuous step.
        <div className="renderer-status">
          <ArtifactLoadingState label="Opening artifact…" />
        </div>
      ) : status === 'unavailable' ? (
        <div className="renderer-status" role="status">
          <span className="status-mark" aria-hidden="true" />
          <p>Preview unavailable</p>
        </div>
      ) : null}
      <iframe
        allow=""
        aria-hidden={status !== 'ready'}
        className="renderer-frame"
        data-preview-theme={theme}
        name={frameNameRef.current}
        onError={recoverFrame}
        onLoad={stopPostReadyNavigation}
        ref={attachFrame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src="about:blank"
        style={{ colorScheme: theme }}
        tabIndex={status === 'ready' ? undefined : -1}
        title={`${path ?? resolution.artifact.name} isolated preview`}
      />
    </div>
  );
}
