import { ChatCircleDotsIcon } from '@phosphor-icons/react/ChatCircleDots';
import { FunnelSimpleIcon } from '@phosphor-icons/react/FunnelSimple';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass';
import { TreeStructureIcon } from '@phosphor-icons/react/TreeStructure';
import { UsersThreeIcon } from '@phosphor-icons/react/UsersThree';
import { XIcon } from '@phosphor-icons/react/X';
import type { ReviewSidebarMode } from './types.js';

export interface ReviewSidebarToolbarProps {
  readonly mode?: ReviewSidebarMode | undefined;
  readonly threadCount: number;
  readonly participantCount: number;
  readonly searchOpen: boolean;
  readonly searchLabel?: string;
  readonly onModeChange?: ((mode: ReviewSidebarMode) => void) | undefined;
  readonly onSearchToggle: () => void;
  readonly onClose?: (() => void) | undefined;
}

export function ReviewSidebarToolbar({
  mode,
  threadCount,
  participantCount,
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
            className="review-sidebar-tool"
            onClick={() => onModeChange('tree')}
            role="tab"
            title="File tree"
            type="button"
          >
            <TreeStructureIcon aria-hidden="true" size={18} weight="regular" />
          </button>
          <button
            aria-label={`Show discussion${threadCount > 0 ? `, ${threadCount} threads` : ''}`}
            aria-selected={mode === 'discussion'}
            className="review-sidebar-tool review-sidebar-discussion-tool"
            onClick={() => onModeChange('discussion')}
            role="tab"
            title="Discussion"
            type="button"
          >
            <ChatCircleDotsIcon aria-hidden="true" size={18} weight="regular" />
            {threadCount > 0 ? <span>{threadCount > 99 ? '99+' : threadCount}</span> : null}
          </button>
        </div>
      ) : (
        <div className="review-sidebar-heading">
          <ChatCircleDotsIcon aria-hidden="true" size={18} weight="regular" />
          <span>Discussion</span>
        </div>
      )}
      <div className="review-sidebar-summary">
        <span title={`${participantCount} participants`}>
          <UsersThreeIcon aria-hidden="true" size={14} weight="regular" />
          {participantCount}
        </span>
        <span title={`${threadCount} threads`}>
          <ChatCircleDotsIcon aria-hidden="true" size={14} weight="regular" />
          {threadCount}
        </span>
      </div>
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
        <button
          aria-label="Discussion filters"
          className="review-sidebar-tool"
          disabled
          title="Filters coming soon"
          type="button"
        >
          <FunnelSimpleIcon aria-hidden="true" size={18} weight="regular" />
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
