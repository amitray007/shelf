import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { FunnelIcon } from '@phosphor-icons/react/Funnel';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/MagnifyingGlass';
import { SidebarSimpleIcon } from '@phosphor-icons/react/SidebarSimple';
import { XIcon } from '@phosphor-icons/react/X';
import type { RefObject } from 'react';
import { REVIEW_THREAD_FILTERS, type ReviewSidebarMode, type ReviewThreadFilter } from './types.js';

export interface ReviewSidebarToolbarProps {
  readonly mode?: ReviewSidebarMode | undefined;
  readonly discussionCount?: number | undefined;
  readonly searchOpen: boolean;
  readonly searchLabel?: string;
  readonly onModeChange?: ((mode: ReviewSidebarMode) => void) | undefined;
  readonly onSearchToggle: () => void;
  readonly threadFilter?: ReviewThreadFilter | undefined;
  readonly onThreadFilterChange?: ((filter: ReviewThreadFilter) => void) | undefined;
  readonly onCollapse?: (() => void) | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly sidebarLabel?: string | undefined;
  readonly onClose?: (() => void) | undefined;
}

export function ReviewSidebarRail({
  onOpen,
  buttonRef,
  sidebarLabel = 'review sidebar',
  sidebarControlsId,
}: {
  readonly onOpen: () => void;
  readonly buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
  readonly sidebarLabel?: string | undefined;
  readonly sidebarControlsId?: string | undefined;
}) {
  return (
    <div className="review-sidebar-rail">
      <button
        aria-controls={sidebarControlsId}
        aria-expanded={false}
        aria-label={`Open ${sidebarLabel}`}
        className="review-sidebar-tool review-sidebar-rail-button"
        onClick={onOpen}
        ref={buttonRef}
        title={`Open ${sidebarLabel}`}
        type="button"
      >
        <SidebarSimpleIcon aria-hidden="true" size={18} weight="regular" />
      </button>
    </div>
  );
}

export function ReviewSidebarToolbar({
  mode,
  discussionCount = 0,
  searchOpen,
  searchLabel = 'Search discussions',
  onModeChange,
  onSearchToggle,
  threadFilter,
  onThreadFilterChange,
  onCollapse,
  sidebarControlsId,
  sidebarLabel = 'review sidebar',
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
        {onCollapse ? (
          <button
            aria-controls={sidebarControlsId}
            aria-expanded={true}
            aria-label={`Collapse ${sidebarLabel}`}
            className="review-sidebar-tool"
            onClick={onCollapse}
            title={`Collapse ${sidebarLabel}`}
            type="button"
          >
            <SidebarSimpleIcon aria-hidden="true" size={18} weight="regular" />
          </button>
        ) : null}
        {threadFilter !== undefined && onThreadFilterChange !== undefined ? (
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <button
                  aria-label="Filter discussions"
                  aria-pressed={threadFilter !== 'all'}
                  className="review-sidebar-tool"
                  title="Filter discussions"
                  type="button"
                />
              }
            >
              <FunnelIcon aria-hidden="true" size={18} weight="regular" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end">
              {REVIEW_THREAD_FILTERS.map(({ value, label }) => (
                <DropdownMenu.Item key={value} onClick={() => onThreadFilterChange(value)}>
                  {label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        ) : null}
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
