import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass';
import { XIcon } from '@phosphor-icons/react/X';
import type { ReviewSidebarMode } from './types.js';

export interface ReviewSidebarToolbarProps {
  readonly mode?: ReviewSidebarMode | undefined;
  readonly discussionCount?: number | undefined;
  readonly searchOpen: boolean;
  readonly searchLabel?: string;
  readonly onModeChange?: ((mode: ReviewSidebarMode) => void) | undefined;
  readonly onSearchToggle: () => void;
  readonly onClose?: (() => void) | undefined;
}

export function ReviewSidebarToolbar({
  mode,
  discussionCount = 0,
  searchOpen,
  searchLabel = 'Search discussions',
  onModeChange,
  onSearchToggle,
  onClose,
}: ReviewSidebarToolbarProps) {
  return (
    <div aria-label="Review tools" className="review-sidebar-toolbar" role="toolbar">
      {onModeChange ? (
        <div className="review-sidebar-modes" role="tablist" aria-label="Sidebar view">
          <button
            aria-label="Show file tree"
            aria-selected={mode === 'tree'}
            className="review-sidebar-mode"
            onClick={() => onModeChange('tree')}
            role="tab"
            type="button"
          >
            Files
          </button>
          <button
            aria-label="Show discussion"
            aria-selected={mode === 'discussion'}
            className="review-sidebar-mode"
            onClick={() => onModeChange('discussion')}
            role="tab"
            type="button"
          >
            Discussion
            {discussionCount > 0 ? (
              <span className="review-sidebar-count">{discussionCount}</span>
            ) : null}
          </button>
        </div>
      ) : (
        <div className="review-sidebar-heading">
          <span>Discussion</span>
          {discussionCount > 0 ? (
            <span className="review-sidebar-count">{discussionCount}</span>
          ) : null}
        </div>
      )}
      <div className="review-sidebar-actions">
        <button
          aria-label={searchOpen ? `Close ${searchLabel.toLowerCase()}` : searchLabel}
          aria-pressed={searchOpen}
          className="review-sidebar-tool"
          onClick={onSearchToggle}
          title={searchOpen ? `Close ${searchLabel.toLowerCase()}` : searchLabel}
          type="button"
        >
          <MagnifyingGlassIcon aria-hidden="true" size={18} weight="regular" />
        </button>
        {onClose ? (
          <button
            aria-label="Close discussion"
            className="review-sidebar-tool"
            onClick={onClose}
            title="Close discussion"
            type="button"
          >
            <XIcon aria-hidden="true" size={18} weight="regular" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
