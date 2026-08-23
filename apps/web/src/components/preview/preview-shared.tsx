// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Scrollable preview panes must be keyboard reachable.

import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

import './structured-data-preview.css';

export type PreviewMode = 'preview' | 'source';

interface PreviewModeTabsProps {
  readonly activeMode: PreviewMode;
  readonly onModeChange: (mode: PreviewMode) => void;
  readonly previewLabel?: string;
  readonly sourceLabel?: string;
  readonly label?: string;
}

export function PreviewModeTabs({
  activeMode,
  label = 'Artifact view mode',
  onModeChange,
  previewLabel = 'Preview',
  sourceLabel = 'Source',
}: PreviewModeTabsProps) {
  const id = useId().replaceAll(':', '');
  const tabRefs = useRef<Partial<Record<PreviewMode, HTMLButtonElement>>>({});
  const modes: readonly PreviewMode[] = ['preview', 'source'];

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const currentIndex = modes.indexOf(event.currentTarget.dataset.mode as PreviewMode);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? modes.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length;
    const nextMode = modes[nextIndex] ?? 'preview';
    onModeChange(nextMode);
    tabRefs.current[nextMode]?.focus();
  };

  return (
    <div aria-label={label} className="preview-mode-tabs" role="tablist">
      {modes.map((mode) => {
        const selected = mode === activeMode;
        const tabId = `${id}-${mode}-tab`;
        return (
          <button
            aria-selected={selected}
            className="preview-mode-tab"
            data-mode={mode}
            id={tabId}
            key={mode}
            onClick={() => onModeChange(mode)}
            onKeyDown={handleKeyDown}
            ref={(element) => {
              if (element === null) delete tabRefs.current[mode];
              else tabRefs.current[mode] = element;
            }}
            role="tab"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {mode === 'preview' ? previewLabel : sourceLabel}
          </button>
        );
      })}
    </div>
  );
}

export function PreviewPanel({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <section aria-label={label} className="preview-panel" role="tabpanel" tabIndex={0}>
      {children}
    </section>
  );
}

export function SourcePane({
  source,
  label = 'Artifact source',
}: {
  readonly source: string;
  readonly label?: string;
}) {
  return (
    <section aria-label={label} className="preview-source-shell">
      <pre className="preview-source" tabIndex={0}>
        {source}
      </pre>
    </section>
  );
}

export function ParseErrorNotice({
  error,
  source,
}: {
  readonly error: string;
  readonly source: string;
}) {
  return (
    <div className="preview-parse-error" role="alert">
      <div className="preview-parse-error-heading">
        <strong>Preview unavailable</strong>
        <span>{error}</span>
      </div>
      <p>The original source is shown below and remains available in Source mode.</p>
      <SourcePane label="Source fallback" source={source} />
    </div>
  );
}
