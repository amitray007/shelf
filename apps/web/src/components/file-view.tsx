// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable file content must be keyboard reachable.

import { Button } from '@cloudflare/kumo/components/button';
import { Tabs } from '@cloudflare/kumo/components/tabs';
import { ChatCircleDotsIcon } from '@phosphor-icons/react/ChatCircleDots';
import { CheckIcon } from '@phosphor-icons/react/Check';
import { CopyIcon } from '@phosphor-icons/react/Copy';
import { GearSixIcon } from '@phosphor-icons/react/GearSix';
import { ListNumbersIcon } from '@phosphor-icons/react/ListNumbers';
import { SidebarSimpleIcon } from '@phosphor-icons/react/SidebarSimple';
import { TextAlignLeftIcon } from '@phosphor-icons/react/TextAlignLeft';
import type { LineAnnotation, SelectedLineRange } from '@pierre/diffs';
import type { FileContents, FileOptions, FileProps } from '@pierre/diffs/react';
import type { CommentAnchor, CommentThread } from '@shelf/contracts';
import {
  type ComponentType,
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ReviewComposer } from './review/discussion-panel.js';
import { InlineSourceThread, type InlineSourceThreadData } from './review/inline-source-thread.js';

type SourceLineAnnotationMetadata =
  | { readonly kind?: 'label'; readonly label: string }
  | {
      readonly expanded: boolean;
      readonly kind: 'threads';
      readonly label: string;
      readonly participantPosts: InlineSourceThreadData['participantPosts'];
      readonly posts: InlineSourceThreadData['posts'];
    }
  | {
      readonly kind: 'composer';
      readonly label: string;
      readonly selection: SelectedLineRange;
    };
export type SourceLineAnnotation = LineAnnotation<SourceLineAnnotationMetadata>;

interface SourceThreadGroup {
  readonly lineNumber: number;
  readonly threads: readonly CommentThread[];
}

export interface FileReviewProps {
  readonly canCreateThread: boolean;
  readonly revisionId: string;
  readonly path?: string;
  readonly activeThreadId?: string | undefined;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly threads: readonly CommentThread[];
  readonly onCreateThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
  readonly saving?: boolean | undefined;
  readonly onSelectThread: (threadId: string) => void;
}

export function groupSourceThreadsByLine(
  threads: readonly CommentThread[],
  fileName: string,
): readonly SourceThreadGroup[] {
  const grouped = new Map<number, CommentThread[]>();
  for (const thread of threads) {
    if (thread.posts.length === 0) continue;
    const lineNumber = thread.anchor.startLine;
    if (
      lineNumber === undefined ||
      (thread.anchor.path !== undefined && thread.anchor.path !== fileName)
    ) {
      continue;
    }
    const lineThreads = grouped.get(lineNumber) ?? [];
    lineThreads.push(thread);
    grouped.set(lineNumber, lineThreads);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([lineNumber, lineThreads]) => ({ lineNumber, threads: lineThreads }));
}

const PierreFile = lazy(async () => {
  const module = await import('@pierre/diffs/react');
  return {
    default: module.File as ComponentType<FileProps<SourceLineAnnotationMetadata>>,
  };
});

function pierreSourceCSS(fontSize: number): string {
  return `
:host {
  --diffs-bg: var(--canvas);
  --diffs-bg-context-override: var(--canvas);
  --diffs-bg-context-gutter-override: var(--surface);
  --diffs-bg-hover-override: var(--surface);
  --diffs-bg-selection-override: color-mix(in srgb, var(--action) 18%, var(--canvas));
  --diffs-fg: var(--text);
  --diffs-fg-number-override: var(--text-muted);
  --diffs-font-family: "Geist Mono Variable", ui-monospace, monospace;
  --diffs-font-size: ${fontSize}px;
  --diffs-line-height: 1.65;
  --diffs-tab-size: 2;
}

[data-utility-button] {
  border: 1px solid color-mix(in srgb, var(--text) 82%, var(--rule-strong));
  border-radius: 4px;
  background: var(--text);
  color: var(--canvas);
  box-shadow: 0 1px 3px rgb(0 0 0 / 22%);
}

[data-utility-button]:hover {
  background: var(--text-subtle);
}
`;
}

export type FileViewMode = 'preview' | 'source';

type LineHoverHighlight = 'disabled' | 'both' | 'number' | 'line';

export interface SourceViewSettings {
  readonly annotations: boolean;
  readonly comments: boolean;
  readonly enableGutterUtility: boolean;
  readonly enableLineSelection: boolean;
  readonly keyboardNavigation: boolean;
  readonly lineHoverHighlight: LineHoverHighlight;
  readonly lineNumbers: boolean;
  readonly maxTokenizeLength: number;
  readonly maxTokenizeLineLength: number;
  readonly fontSize: number;
  readonly stickyHeader: boolean;
  readonly tokenInteractions: boolean;
  readonly wrap: boolean;
}

export const DEFAULT_SOURCE_VIEW_SETTINGS: SourceViewSettings = {
  annotations: true,
  comments: true,
  enableGutterUtility: true,
  enableLineSelection: true,
  keyboardNavigation: true,
  lineHoverHighlight: 'line',
  lineNumbers: true,
  maxTokenizeLength: 100_000,
  maxTokenizeLineLength: 1_000,
  fontSize: 13,
  stickyHeader: true,
  tokenInteractions: true,
  wrap: true,
};

export function sourceCommentsVisible(
  settings: Pick<SourceViewSettings, 'annotations' | 'comments'>,
): boolean {
  return settings.comments && settings.annotations;
}

export function sourceLineSelectionEnabled(settings: SourceViewSettings): boolean {
  return settings.enableLineSelection && sourceCommentsVisible(settings);
}

export function toggleSourceComments(settings: SourceViewSettings): SourceViewSettings {
  if (sourceCommentsVisible(settings)) return { ...settings, comments: false };
  return { ...settings, annotations: true, comments: true };
}

export function viewerSessionStorageKey(namespace: string, context = ''): string {
  if (typeof window === 'undefined') return `shelf:${namespace}:server`;
  const storageContext = `${window.location.origin}${window.location.pathname}${window.location.search}${context === '' ? '' : `\u0000${context}`}`;
  let hash = 2_166_136_261;
  for (const character of storageContext) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `shelf:${namespace}:${(hash >>> 0).toString(36)}`;
}

function readFileViewMode(fileName: string, hasPreview: boolean, hasSource: boolean): FileViewMode {
  const fallback = hasPreview ? 'preview' : 'source';
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.sessionStorage.getItem(
      viewerSessionStorageKey('file-view-mode', fileName),
    );
    if (value === 'source' && hasSource) return value;
    if (value === 'preview' && hasPreview) return value;
  } catch {
    // View state remains usable when browser storage is unavailable.
  }
  return fallback;
}

function readSourceViewSettings(): SourceViewSettings {
  if (typeof window === 'undefined') return DEFAULT_SOURCE_VIEW_SETTINGS;
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(viewerSessionStorageKey('source-settings')) ?? 'null',
    ) as Partial<SourceViewSettings> | null;
    if (value === null || typeof value !== 'object') return DEFAULT_SOURCE_VIEW_SETTINGS;
    const lineHoverHighlight =
      value.lineHoverHighlight === 'disabled' ||
      value.lineHoverHighlight === 'both' ||
      value.lineHoverHighlight === 'number' ||
      value.lineHoverHighlight === 'line'
        ? value.lineHoverHighlight
        : DEFAULT_SOURCE_VIEW_SETTINGS.lineHoverHighlight;
    const numberSetting = (candidate: unknown, fallback: number, min: number, max: number) =>
      typeof candidate === 'number' && Number.isFinite(candidate)
        ? Math.min(max, Math.max(min, candidate))
        : fallback;
    return {
      ...DEFAULT_SOURCE_VIEW_SETTINGS,
      ...value,
      annotations: value.annotations !== false,
      comments: value.comments !== false,
      enableGutterUtility: value.enableGutterUtility !== false,
      enableLineSelection: value.enableLineSelection !== false,
      keyboardNavigation: value.keyboardNavigation !== false,
      lineHoverHighlight,
      lineNumbers: value.lineNumbers !== false,
      maxTokenizeLength: numberSetting(
        value.maxTokenizeLength,
        DEFAULT_SOURCE_VIEW_SETTINGS.maxTokenizeLength,
        10_000,
        2_000_000,
      ),
      maxTokenizeLineLength: numberSetting(
        value.maxTokenizeLineLength,
        DEFAULT_SOURCE_VIEW_SETTINGS.maxTokenizeLineLength,
        256,
        100_000,
      ),
      fontSize: numberSetting(value.fontSize, DEFAULT_SOURCE_VIEW_SETTINGS.fontSize, 11, 18),
      stickyHeader: value.stickyHeader !== false,
      tokenInteractions: value.tokenInteractions !== false,
      wrap: value.wrap !== false,
    };
  } catch {
    return DEFAULT_SOURCE_VIEW_SETTINGS;
  }
}

export function decodeFileSource(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function PierreCode({
  fileName,
  lineNumbers,
  lineAnnotations,
  onCopyLine,
  onAnnotationToggle,
  onAddComment,
  onCancelInlineComment,
  onCreateInlineComment,
  onDeletePost,
  onEditPost,
  onLineSelectionChange,
  saving,
  selectedLines,
  settings,
  source,
  focusLine,
  focusRequestId,
  wrap,
}: {
  readonly fileName: string;
  readonly lineNumbers: boolean;
  readonly lineAnnotations?: readonly SourceLineAnnotation[];
  readonly onCopyLine?: (range: SelectedLineRange) => void;
  readonly onAnnotationToggle?: ((lineNumber: number) => void) | undefined;
  readonly onAddComment?: ((range: SelectedLineRange) => void) | undefined;
  readonly onCancelInlineComment?: (() => void) | undefined;
  readonly onCreateInlineComment?:
    | ((range: SelectedLineRange, body: string) => Promise<void>)
    | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly onLineSelectionChange?: ((range: SelectedLineRange | null) => void) | undefined;
  readonly saving?: boolean | undefined;
  readonly selectedLines?: SelectedLineRange | null;
  readonly settings?: SourceViewSettings;
  readonly source: string;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly wrap: boolean;
}) {
  const file = useMemo<FileContents>(
    () => ({ name: fileName, contents: source }),
    [fileName, source],
  );
  const options = useMemo<FileOptions<SourceLineAnnotationMetadata>>(
    () => ({
      disableFileHeader: true,
      disableLineNumbers: !lineNumbers,
      overflow: wrap ? ('wrap' as const) : ('scroll' as const),
      theme: 'github-dark',
      themeType: 'dark' as const,
      unsafeCSS: pierreSourceCSS(settings?.fontSize ?? DEFAULT_SOURCE_VIEW_SETTINGS.fontSize),
      ...(settings === undefined
        ? {}
        : {
            enableGutterUtility: settings.enableGutterUtility,
            enableLineSelection: sourceLineSelectionEnabled(settings),
            enableTokenInteractionsOnWhitespace: settings.tokenInteractions,
            lineHoverHighlight: settings.lineHoverHighlight,
            stickyHeader: settings.stickyHeader,
            tokenizeMaxLength: settings.maxTokenizeLength,
            tokenizeMaxLineLength: settings.maxTokenizeLineLength,
            ...(onAddComment !== undefined
              ? { onGutterUtilityClick: onAddComment }
              : onCopyLine !== undefined
                ? { onGutterUtilityClick: onCopyLine }
                : {}),
            ...(onLineSelectionChange === undefined ? {} : { onLineSelectionChange }),
            ...(focusLine === undefined
              ? {}
              : {
                  onPostRender: (_node, instance) => {
                    // A navigation request gets a fresh active-line write even when
                    // the target line is unchanged, so repeated Line links re-center it.
                    if (focusRequestId !== undefined) instance.setEditorActiveLine(null);
                    instance.setEditorActiveLine(focusLine);
                    const container = _node.shadowRoot;
                    if (container === null) return;
                    const revealLine = () => {
                      container
                        .querySelector<HTMLElement>(`[data-line="${focusLine}"]`)
                        ?.scrollIntoView({ block: 'center', behavior: 'auto' });
                    };
                    if (typeof window === 'undefined') revealLine();
                    else window.requestAnimationFrame(revealLine);
                  },
                }),
          }),
    }),
    [
      focusLine,
      focusRequestId,
      lineNumbers,
      onAddComment,
      onCopyLine,
      onLineSelectionChange,
      settings,
      wrap,
    ],
  );
  const mutableLineAnnotations = useMemo(
    () => (lineAnnotations === undefined ? undefined : [...lineAnnotations]),
    [lineAnnotations],
  );

  const annotationProps =
    mutableLineAnnotations !== undefined && mutableLineAnnotations.length > 0
      ? {
          lineAnnotations: mutableLineAnnotations,
          renderAnnotation: (annotation: SourceLineAnnotation) => {
            const metadata = annotation.metadata;
            if (metadata?.kind === 'composer' && onCreateInlineComment !== undefined) {
              return (
                <div className="pierre-inline-composer">
                  <div className="pierre-inline-composer-heading">
                    <span>
                      {metadata.selection.start === metadata.selection.end
                        ? `Comment on line ${metadata.selection.start}`
                        : `Comment on lines ${metadata.selection.start}–${metadata.selection.end}`}
                    </span>
                    <button
                      aria-label="Cancel comment draft"
                      onClick={onCancelInlineComment}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                  <ReviewComposer
                    autoFocus
                    docked
                    onSubmit={(body) => onCreateInlineComment(metadata.selection, body)}
                    placeholder="Leave a comment…"
                  />
                </div>
              );
            }
            if (metadata?.kind === 'threads') {
              return (
                <InlineSourceThread
                  data={metadata}
                  lineNumber={annotation.lineNumber}
                  onAnnotationToggle={() => onAnnotationToggle?.(annotation.lineNumber)}
                  onDeletePost={onDeletePost}
                  onEditPost={onEditPost}
                  saving={saving}
                />
              );
            }
            return (
              <span className="pierre-line-annotation">
                {metadata?.label ?? `Line ${annotation.lineNumber}`}
              </span>
            );
          },
        }
      : {};
  const selectionProps =
    settings !== undefined && sourceLineSelectionEnabled(settings)
      ? { selectedLines: selectedLines ?? null }
      : { selectedLines: null };

  return (
    <Suspense fallback={<FileLoadingState />}>
      <PierreFile file={file} options={options} {...annotationProps} {...selectionProps} />
    </Suspense>
  );
}

export function CodeView({
  fileName = 'source.txt',
  label,
  source,
}: {
  readonly fileName?: string | undefined;
  readonly label: string;
  readonly source: string;
}) {
  return (
    <section aria-label={label} className="artifact-surface artifact-code" tabIndex={0}>
      <PierreCode fileName={fileName} lineNumbers={false} source={source} wrap={false} />
    </section>
  );
}

export function SourceView({
  annotations = [],
  fileName = 'source.txt',
  focusLine,
  focusRequestId,
  review,
  source,
}: {
  readonly annotations?: readonly SourceLineAnnotation[];
  readonly fileName?: string | undefined;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly review?: FileReviewProps | undefined;
  readonly source: string;
}) {
  const [settings, setSettings] = useState<SourceViewSettings>(readSourceViewSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [expandedLineNumber, setExpandedLineNumber] = useState<number | undefined>();
  const commentsVisible = sourceCommentsVisible(settings);
  const createThread = review?.onCreateThread;
  const canCreateThread = review?.canCreateThread === true && createThread !== undefined;
  const inlineDraftOpen = selectedLines !== null;
  const settingsRef = useRef<HTMLDivElement>(null);
  const lineCount = useMemo(() => Math.max(1, source.split(/\r?\n/u).length), [source]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        viewerSessionStorageKey('source-settings'),
        JSON.stringify(settings),
      );
    } catch {
      // Session storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [settings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsRef.current?.contains(event.target)) {
        setSettingsOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!settings.enableLineSelection) setSelectedLines(null);
  }, [settings.enableLineSelection]);

  useEffect(() => {
    if (!commentsVisible) {
      setSelectedLines(null);
      setExpandedLineNumber(undefined);
    }
  }, [commentsVisible]);

  useEffect(() => {
    if (!inlineDraftOpen) return;
    const discardInlineDraft = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedLines(null);
    };
    document.addEventListener('keydown', discardInlineDraft);
    return () => document.removeEventListener('keydown', discardInlineDraft);
  }, [inlineDraftOpen]);

  useEffect(() => {
    if (focusLine === undefined || !Number.isInteger(focusLine) || focusLine < 1) return;
    setSettings((current) =>
      sourceCommentsVisible(current) ? current : { ...current, annotations: true, comments: true },
    );
    setExpandedLineNumber(focusLine);
  }, [focusLine]);

  const updateSettings = <K extends keyof SourceViewSettings>(
    key: K,
    value: SourceViewSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const copySource = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const copyLineLink = useCallback(async (range: SelectedLineRange) => {
    if (!navigator.clipboard || typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('line', `L${range.start}`);
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is optional, especially in embedded viewers.
    }
  }, []);

  const sourceThreadGroups = useMemo(
    () => groupSourceThreadsByLine(review?.threads ?? [], fileName),
    [fileName, review?.threads],
  );
  const toggleSourceAnnotation = (lineNumber: number) => {
    const closing = expandedLineNumber === lineNumber;
    if (closing) {
      const group = sourceThreadGroups.find((candidate) => candidate.lineNumber === lineNumber);
      if (
        review?.activeThreadId !== undefined &&
        group?.threads.some((thread) => thread.threadId === review.activeThreadId)
      ) {
        review.onSelectThread('');
      }
    }
    setExpandedLineNumber(closing ? undefined : lineNumber);
  };
  const annotationCount = annotations.length + sourceThreadGroups.length;
  const lineAnnotations = useMemo<readonly SourceLineAnnotation[]>(() => {
    const visibleAnnotations: SourceLineAnnotation[] = settings.annotations
      ? [
          ...annotations,
          ...(commentsVisible
            ? sourceThreadGroups.map(({ lineNumber, threads }) => {
                const posts = threads.flatMap((thread) => thread.posts);
                const participantPosts = [
                  ...new Map(posts.map((post) => [post.author.participantId, post])).values(),
                ];
                return {
                  lineNumber,
                  metadata: {
                    expanded: expandedLineNumber === lineNumber,
                    kind: 'threads' as const,
                    label: `${posts.length} ${posts.length === 1 ? 'comment' : 'comments'}`,
                    participantPosts,
                    posts,
                  },
                };
              })
            : []),
        ]
      : [];
    if (commentsVisible && canCreateThread && selectedLines !== null) {
      visibleAnnotations.push({
        lineNumber: selectedLines.end,
        metadata: {
          kind: 'composer',
          label: 'New comment',
          selection: selectedLines,
        },
      });
    }
    return visibleAnnotations;
  }, [
    annotations,
    expandedLineNumber,
    commentsVisible,
    canCreateThread,
    selectedLines,
    settings.annotations,
    sourceThreadGroups,
  ]);

  const handleKeyboardNavigation = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!sourceLineSelectionEnabled(settings) || !settings.keyboardNavigation) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const currentLine = selectedLines?.end ?? 1;
    let nextLine: number | undefined;
    if (event.key === 'ArrowUp') nextLine = Math.max(1, currentLine - 1);
    if (event.key === 'ArrowDown') nextLine = Math.min(lineCount, currentLine + 1);
    if (event.key === 'Home') nextLine = 1;
    if (event.key === 'End') nextLine = lineCount;
    if (nextLine === undefined || nextLine === currentLine) return;
    event.preventDefault();
    setSelectedLines({ end: nextLine, start: nextLine });
  };

  return (
    <section aria-label="Artifact source" className="source-view">
      <div
        className={`source-view-toolbar${settings.stickyHeader ? ' source-view-toolbar-sticky' : ''}`}
      >
        <span className="source-view-label">Source</span>
        <div className="source-view-actions">
          <Button
            aria-label={settings.wrap ? 'Disable word wrap' : 'Enable word wrap'}
            aria-pressed={settings.wrap}
            icon={TextAlignLeftIcon}
            onClick={() => updateSettings('wrap', !settings.wrap)}
            size="sm"
            title={settings.wrap ? 'Disable word wrap' : 'Enable word wrap'}
            type="button"
            variant={settings.wrap ? 'secondary' : 'ghost'}
          >
            Wrap
          </Button>
          <Button
            aria-label={settings.lineNumbers ? 'Hide line numbers' : 'Show line numbers'}
            aria-pressed={settings.lineNumbers}
            icon={ListNumbersIcon}
            onClick={() => updateSettings('lineNumbers', !settings.lineNumbers)}
            size="sm"
            title={settings.lineNumbers ? 'Hide line numbers' : 'Show line numbers'}
            type="button"
            variant={settings.lineNumbers ? 'secondary' : 'ghost'}
          >
            Lines
          </Button>
          <Button
            aria-label={commentsVisible ? 'Hide comments' : 'Show comments'}
            aria-pressed={commentsVisible}
            icon={ChatCircleDotsIcon}
            onClick={() => setSettings(toggleSourceComments)}
            size="sm"
            title={commentsVisible ? 'Hide comments' : 'Show comments'}
            type="button"
            variant={commentsVisible ? 'secondary' : 'ghost'}
          >
            Comments
          </Button>
          <Button
            aria-label={copied ? 'Copied source' : 'Copy source'}
            icon={copied ? CheckIcon : CopyIcon}
            onClick={() => void copySource()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <div className="source-view-settings" ref={settingsRef}>
            <Button
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              aria-label="Source view settings"
              icon={GearSixIcon}
              onClick={() => setSettingsOpen((value) => !value)}
              size="sm"
              title="Source view settings"
              type="button"
              variant={settingsOpen ? 'secondary' : 'ghost'}
            />
            {settingsOpen ? (
              <div
                aria-label="Source view settings"
                className="source-view-settings-popover"
                role="dialog"
              >
                <div className="source-view-settings-heading">
                  <strong>Source view</strong>
                  <span>Saved for this session link</span>
                </div>
                <div className="source-view-settings-grid">
                  <label className="source-view-setting-field">
                    <span>Font size</span>
                    <select
                      onChange={(event) => updateSettings('fontSize', Number(event.target.value))}
                      value={settings.fontSize}
                    >
                      {[11, 12, 13, 14, 15, 16, 18].map((size) => (
                        <option key={size} value={size}>
                          {size}px
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="source-view-setting-field">
                    <span>Line hover</span>
                    <select
                      onChange={(event) =>
                        updateSettings(
                          'lineHoverHighlight',
                          event.target.value as LineHoverHighlight,
                        )
                      }
                      value={settings.lineHoverHighlight}
                    >
                      <option value="line">Line</option>
                      <option value="number">Number</option>
                      <option value="both">Line + number</option>
                      <option value="disabled">Off</option>
                    </select>
                  </label>
                  <label className="source-view-setting-field">
                    <span>Long lines</span>
                    <select
                      onChange={(event) =>
                        updateSettings('maxTokenizeLineLength', Number(event.target.value))
                      }
                      value={settings.maxTokenizeLineLength}
                    >
                      <option value={1000}>Default · 1k</option>
                      <option value={5000}>5k</option>
                      <option value={10000}>10k</option>
                      <option value={25000}>25k</option>
                    </select>
                  </label>
                  <label className="source-view-setting-field">
                    <span>File limit</span>
                    <select
                      onChange={(event) =>
                        updateSettings('maxTokenizeLength', Number(event.target.value))
                      }
                      value={settings.maxTokenizeLength}
                    >
                      <option value={100000}>Default · 100k</option>
                      <option value={250000}>250k</option>
                      <option value={500000}>500k</option>
                      <option value={1000000}>1m</option>
                    </select>
                  </label>
                </div>
                <div className="source-view-settings-section">
                  <span className="source-view-settings-section-label">Interaction</span>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.stickyHeader}
                      onChange={(event) => updateSettings('stickyHeader', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Sticky file header</span>
                  </label>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.enableLineSelection}
                      onChange={(event) =>
                        updateSettings('enableLineSelection', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Line selection</span>
                  </label>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.keyboardNavigation}
                      disabled={!settings.enableLineSelection}
                      onChange={(event) =>
                        updateSettings('keyboardNavigation', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Keyboard navigation</span>
                  </label>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.enableGutterUtility}
                      onChange={(event) =>
                        updateSettings('enableGutterUtility', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Gutter line links</span>
                  </label>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.tokenInteractions}
                      onChange={(event) =>
                        updateSettings('tokenInteractions', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Token interactions</span>
                  </label>
                  <label className="source-view-setting-toggle">
                    <input
                      checked={settings.annotations}
                      disabled={annotationCount === 0}
                      onChange={(event) => updateSettings('annotations', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Annotations {annotationCount === 0 ? '(none available)' : ''}</span>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <section
        aria-label="Source code"
        className="source-view-content"
        onKeyDown={handleKeyboardNavigation}
        tabIndex={0}
      >
        <PierreCode
          fileName={fileName}
          lineAnnotations={lineAnnotations}
          lineNumbers={settings.lineNumbers}
          {...(canCreateThread
            ? {}
            : { onCopyLine: (range: SelectedLineRange) => void copyLineLink(range) })}
          onAddComment={canCreateThread && commentsVisible ? setSelectedLines : undefined}
          onAnnotationToggle={toggleSourceAnnotation}
          onCancelInlineComment={() => setSelectedLines(null)}
          onDeletePost={review?.onDeletePost}
          onEditPost={review?.onEditPost}
          onCreateInlineComment={
            canCreateThread && createThread !== undefined
              ? async (range, body) => {
                  await createThread(
                    {
                      revisionId: review.revisionId,
                      ...(review.path === undefined ? {} : { path: review.path }),
                      kind: 'range',
                      startLine: range.start,
                      endLine: range.end,
                    },
                    body,
                  );
                  setSelectedLines(null);
                }
              : undefined
          }
          onLineSelectionChange={
            sourceLineSelectionEnabled(settings) ? setSelectedLines : undefined
          }
          saving={review?.saving}
          selectedLines={selectedLines}
          settings={settings}
          source={source}
          focusLine={focusLine ?? review?.focusLine}
          focusRequestId={focusRequestId ?? review?.focusRequestId}
          wrap={settings.wrap}
        />
      </section>
    </section>
  );
}

export function FileLoadingState() {
  return (
    <div aria-live="polite" className="file-loading-state" role="status">
      <span aria-hidden="true" className="file-loading-spinner" />
      <span>Loading file…</span>
      <div aria-hidden="true" className="file-loading-skeleton">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function FileView({
  annotations,
  header,
  fileName,
  focusLine,
  focusRequestId,
  preview,
  review,
  sidebarControlsId,
  sidebarLabel,
  sidebarOpen,
  onOpenSidebar,
  source,
}: {
  readonly annotations?: readonly SourceLineAnnotation[];
  readonly header?: React.ReactNode;
  readonly fileName?: string | undefined;
  readonly focusLine?: number | undefined;
  readonly focusRequestId?: number | undefined;
  readonly preview?: React.ReactNode;
  readonly review?: FileReviewProps | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly sidebarLabel?: string | undefined;
  readonly sidebarOpen?: boolean | undefined;
  readonly onOpenSidebar?: (() => void) | undefined;
  readonly source?: string;
}) {
  const hasContent = preview !== undefined || source !== undefined;
  const hasModes = preview !== undefined && source !== undefined;
  const [mode, setMode] = useState<FileViewMode>(() =>
    readFileViewMode(fileName ?? 'source.txt', preview !== undefined, source !== undefined),
  );
  const requestedFocusLine = focusLine ?? review?.focusLine;
  const requestedFocusRequestId = focusRequestId ?? review?.focusRequestId;
  const openSidebarButtonRef = useRef<HTMLButtonElement>(null);
  const previousSidebarOpenRef = useRef(sidebarOpen);
  const showSidebarToggle = sidebarOpen !== undefined && onOpenSidebar !== undefined;
  const sidebarToggleLabel = `${sidebarOpen ? 'Collapse' : 'Open'} ${sidebarLabel ?? 'review sidebar'}`;

  useEffect(() => {
    if (previousSidebarOpenRef.current && sidebarOpen === false) {
      openSidebarButtonRef.current?.focus();
    }
    previousSidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  useEffect(() => {
    if (requestedFocusLine !== undefined && source !== undefined) setMode('source');
  }, [requestedFocusLine, source]);

  useEffect(() => {
    if (!hasModes) return;
    try {
      window.sessionStorage.setItem(
        viewerSessionStorageKey('file-view-mode', fileName ?? 'source.txt'),
        mode,
      );
    } catch {
      // View state remains usable when browser storage is unavailable.
    }
  }, [fileName, hasModes, mode]);

  if (!hasContent && header === undefined && !showSidebarToggle) return null;
  if (header === undefined && !hasModes && !showSidebarToggle) {
    if (preview === undefined)
      return (
        <SourceView
          {...(annotations === undefined ? {} : { annotations })}
          fileName={fileName}
          focusLine={requestedFocusLine}
          focusRequestId={requestedFocusRequestId}
          review={review}
          source={source ?? ''}
        />
      );
    return preview;
  }

  const activeMode = mode === 'source' ? 'source' : 'preview';
  return (
    <div className="file-view">
      <header className="file-view-toolbar">
        {header === undefined && !showSidebarToggle ? null : (
          <div className="file-view-meta">
            {showSidebarToggle ? (
              <button
                aria-controls={sidebarControlsId}
                aria-expanded={sidebarOpen}
                aria-label={sidebarToggleLabel}
                className="file-view-sidebar-toggle review-sidebar-tool"
                onClick={onOpenSidebar}
                ref={openSidebarButtonRef}
                title={sidebarToggleLabel}
                type="button"
              >
                <SidebarSimpleIcon aria-hidden="true" size={18} weight="regular" />
              </button>
            ) : null}
            {header}
          </div>
        )}
        {hasModes ? (
          <Tabs
            activateOnFocus={false}
            className="file-view-tabs"
            onValueChange={(value) => setMode(value === 'source' ? 'source' : 'preview')}
            size="sm"
            tabs={[
              { value: 'preview', label: 'Preview' },
              { value: 'source', label: 'Source' },
            ]}
            value={activeMode}
            variant="segmented"
          />
        ) : null}
      </header>
      {hasContent ? (
        <div className="file-view-content">
          {hasModes ? (
            activeMode === 'source' ? (
              <SourceView
                {...(annotations === undefined ? {} : { annotations })}
                fileName={fileName}
                focusLine={requestedFocusLine}
                focusRequestId={requestedFocusRequestId}
                review={review}
                source={source ?? ''}
              />
            ) : (
              preview
            )
          ) : (
            (preview ?? (
              <SourceView
                {...(annotations === undefined ? {} : { annotations })}
                fileName={fileName}
                focusLine={requestedFocusLine}
                focusRequestId={requestedFocusRequestId}
                review={review}
                source={source ?? ''}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
