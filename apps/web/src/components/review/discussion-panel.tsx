import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { ArrowLeftIcon } from '@phosphor-icons/react/ArrowLeft';
import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp';
import { DotsThreeIcon } from '@phosphor-icons/react/DotsThree';
import type { CommentAnchor, CommentThread } from '@shelf/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReviewAvatar,
  ReviewAvatarImage,
  ReviewBody,
  ReviewThreadCard,
  ReviewTime,
  reviewAuthorName,
} from './comment-card.js';
import { ReviewEditComposer } from './edit-composer.js';
import { readReviewVisitorIdentity } from './identity.js';
import { VisitorNameDialog } from './identity-dialog.js';
import { ReviewSidebarToolbar } from './sidebar-toolbar.js';
import type { ReviewThreadFilter } from './types.js';

export { ReviewEditComposer } from './edit-composer.js';

function threadLabel(thread: CommentThread): string {
  if (thread.anchor.path !== undefined) return thread.anchor.path;
  if (thread.anchor.startLine !== undefined) return `Line ${thread.anchor.startLine}`;
  return 'File discussion';
}

export interface DiscussionPanelProps {
  readonly moderator?: boolean | undefined;
  readonly threads: readonly CommentThread[];
  readonly activeThreadId?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly loadingOlder?: boolean | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly saving?: boolean | undefined;
  readonly error?: string | undefined;
  readonly onSelectThread: (threadId: string) => void;
  readonly onNavigateToThread?: ((threadId: string) => void) | undefined;
  readonly onCreateThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly onReply: (threadId: string, body: string) => Promise<void>;
  readonly onSetThreadStatus: (threadId: string, status: 'resolve' | 'reopen') => Promise<void>;
  readonly onModeratePost?:
    | ((postId: string, moderation: 'hide' | 'unhide') => Promise<void>)
    | undefined;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
  readonly onClose?: () => void;
  readonly onLoadOlder?: () => Promise<void>;
  readonly showToolbar?: boolean;
  readonly searchOpen?: boolean | undefined;
  readonly onSearchToggle?: (() => void) | undefined;
  readonly threadFilter?: ReviewThreadFilter | undefined;
  readonly onThreadFilterChange?: ((filter: ReviewThreadFilter) => void) | undefined;
  readonly emptyLabel?: string | undefined;
  readonly selectedPath?: string | undefined;
  readonly newAnchor?: CommentAnchor | undefined;
  readonly collapsible?: boolean | undefined;
  readonly collapsed?: boolean | undefined;
  readonly onCollapse?: (() => void) | undefined;
  readonly publicViewer?: boolean | undefined;
  readonly sidebarControlsId?: string | undefined;
  readonly sidebarLabel?: string | undefined;
}

export function ReviewComposer({
  disabled = false,
  docked = false,
  moderator = false,
  onSubmit,
  placeholder = 'Add a note…',
}: {
  readonly disabled?: boolean;
  readonly docked?: boolean;
  readonly moderator?: boolean;
  readonly onSubmit: (body: string) => Promise<void>;
  readonly placeholder?: string;
}) {
  const [body, setBody] = useState('');
  const [nameDialog, setNameDialog] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submitAfterNameRef = useRef(false);
  const identity = readReviewVisitorIdentity();
  const displayName = identity.displayName;
  const avatarSeed = moderator ? 'shelf-team' : displayName || identity.visitorToken || 'reviewer';
  const submit = async () => {
    if (body.trim().length === 0 || pending) return;
    if (!moderator && readReviewVisitorIdentity().displayName.trim().length === 0) {
      submitAfterNameRef.current = true;
      setNameDialog(true);
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onSubmit(body.trim());
      setBody('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this comment.');
    } finally {
      setPending(false);
    }
  };
  const continueWithName = () => {
    const shouldSubmit = submitAfterNameRef.current;
    submitAfterNameRef.current = false;
    setNameDialog(false);
    if (shouldSubmit) void submit();
  };
  return (
    <>
      <div className={`review-composer${docked ? ' review-composer-docked' : ''}`}>
        <div className="review-composer-input">
          {!moderator ? (
            <button
              aria-label={displayName === '' ? 'Add your name' : `Change name for ${displayName}`}
              className="review-composer-avatar"
              onClick={() => {
                submitAfterNameRef.current = false;
                setNameDialog(true);
              }}
              title={displayName === '' ? 'Add your name' : `Commenting as ${displayName}`}
              type="button"
            >
              <ReviewAvatarImage alt="" participantId={avatarSeed} size={36} />
            </button>
          ) : (
            <span className="review-composer-avatar review-composer-avatar-static">
              <ReviewAvatarImage alt="Shelf team avatar" participantId={avatarSeed} size={36} />
            </span>
          )}
          <textarea
            aria-label={placeholder}
            disabled={disabled || pending}
            maxLength={20_000}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            rows={docked ? 1 : 3}
            value={body}
          />
          <button
            aria-label={pending ? 'Saving comment' : 'Submit comment'}
            className="review-composer-submit"
            disabled={disabled || pending || body.trim() === ''}
            onClick={() => void submit()}
            title="Submit comment (⌘↵)"
            type="button"
          >
            <ArrowUpIcon aria-hidden="true" size={18} weight="bold" />
          </button>
        </div>
        {error ? (
          <span aria-live="assertive" className="review-status review-status-error">
            {error}
          </span>
        ) : null}
      </div>
      {nameDialog ? (
        <VisitorNameDialog
          onCancel={() => {
            submitAfterNameRef.current = false;
            setNameDialog(false);
          }}
          onSaved={continueWithName}
        />
      ) : null}
    </>
  );
}

export function DiscussionPanel({
  activeThreadId,
  emptyLabel = 'No discussions yet.',
  error,
  loading = false,
  loadingOlder = false,
  nextCursor = null,
  onClose,
  onLoadOlder,
  onCreateThread,
  onDeletePost,
  onEditPost,
  onReply,
  onModeratePost,
  onNavigateToThread,
  onSelectThread,
  onSetThreadStatus,
  saving = false,
  selectedPath,
  threads,
  newAnchor,
  moderator = false,
  showToolbar = true,
  searchOpen: controlledSearchOpen,
  onSearchToggle,
  threadFilter: controlledThreadFilter,
  onThreadFilterChange,
  collapsible = false,
  collapsed = false,
  onCollapse,
  publicViewer = false,
  sidebarControlsId,
  sidebarLabel = publicViewer ? 'file discussions sidebar' : 'review sidebar',
}: DiscussionPanelProps) {
  const [query, setQuery] = useState('');
  const [localThreadFilter, setLocalThreadFilter] = useState<ReviewThreadFilter>('all');
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [editingPostId, setEditingPostId] = useState<string>();
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState<string>();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeThread = threads.find((thread) => thread.threadId === activeThreadId);
  const searchOpen = controlledSearchOpen ?? localSearchOpen;
  const toggleSearch = onSearchToggle ?? (() => setLocalSearchOpen((open) => !open));
  const threadFilter = controlledThreadFilter ?? localThreadFilter;
  const setThreadFilter = onThreadFilterChange ?? setLocalThreadFilter;
  const threadGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const groups = new Map<
      string,
      { label: string; unresolved: CommentThread[]; resolved: CommentThread[] }
    >();
    for (const thread of threads) {
      if (
        (threadFilter === 'unresolved' && thread.resolvedAt !== null) ||
        (threadFilter === 'resolved' && thread.resolvedAt === null)
      )
        continue;
      if (normalized !== '') {
        const text = thread.posts.map((post) => post.body).join(' ');
        if (!`${threadLabel(thread)} ${text}`.toLowerCase().includes(normalized)) continue;
      }
      const groupKey = thread.anchor.path ?? 'file-discussion';
      let group = groups.get(groupKey);
      if (group === undefined) {
        group = { label: thread.anchor.path ?? 'File discussion', unresolved: [], resolved: [] };
        groups.set(groupKey, group);
      }
      if (thread.resolvedAt === null) group.unresolved.push(thread);
      else group.resolved.push(thread);
    }
    return [...groups.values()];
  }, [query, threadFilter, threads]);
  const visibleThreadCount = threadGroups.reduce(
    (count, group) => count + group.unresolved.length + group.resolved.length,
    0,
  );
  let emptyMessage = emptyLabel;
  if (query.trim() === '') {
    if (threadFilter === 'unresolved') emptyMessage = 'No unresolved discussions.';
    else if (threadFilter === 'resolved') emptyMessage = 'No resolved discussions.';
  }
  const renderThreadButton = (thread: CommentThread) => (
    <div className="review-thread-button" key={thread.threadId}>
      <button
        className="review-thread-select"
        onClick={() => onSelectThread(thread.threadId)}
        type="button"
      >
        <ReviewThreadCard thread={thread} />
      </button>
      {thread.anchor.startLine !== undefined ? (
        <button
          aria-label={`Go to Line ${thread.anchor.startLine}`}
          className="review-thread-location"
          onClick={() => (onNavigateToThread ?? onSelectThread)(thread.threadId)}
          type="button"
        >
          Line {thread.anchor.startLine}
        </button>
      ) : null}
    </div>
  );
  const renderThreadGroup = (group: (typeof threadGroups)[number]) => (
    <section className="review-discussion-file-group" key={group.label}>
      <h3 className="review-discussion-file-heading">{group.label}</h3>
      {group.unresolved.map(renderThreadButton)}
      {group.unresolved.length > 0 && group.resolved.length > 0 ? (
        <div aria-hidden="true" className="review-discussion-status-divider" />
      ) : null}
      {group.resolved.map(renderThreadButton)}
    </section>
  );
  useEffect(() => {
    if (activeThreadId !== undefined) replyRef.current?.focus();
  }, [activeThreadId]);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  const runAction = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not save this review.');
    }
  };
  const panelClassName = `review-panel review-chat-panel${publicViewer ? ' review-panel-public' : ''}`;
  const panelContent = (
    <>
      {showToolbar ? (
        <ReviewSidebarToolbar
          discussionCount={threads.length}
          {...(onCollapse === undefined
            ? {}
            : {
                onCollapse,
                ...(sidebarControlsId === undefined ? {} : { sidebarControlsId }),
                sidebarLabel,
              })}
          onClose={onClose}
          onSearchToggle={toggleSearch}
          searchOpen={searchOpen}
          threadFilter={threadFilter}
          onThreadFilterChange={setThreadFilter}
        />
      ) : null}
      {searchOpen ? (
        <input
          aria-label="Search discussions"
          className="review-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search discussions"
          ref={searchRef}
          type="search"
          value={query}
        />
      ) : null}
      {loading ? (
        <p aria-live="polite" className="review-status">
          Loading discussions…
        </p>
      ) : null}
      {error ? (
        <p aria-live="assertive" className="review-status review-status-error">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p aria-live="assertive" className="review-status review-status-error">
          {actionError}
        </p>
      ) : null}
      <div className="review-panel-body review-chat-body">
        {activeThread ? (
          <section className="review-thread-detail review-chat-thread">
            <header className="review-chat-thread-header">
              <button
                aria-label="Back to discussions"
                className="review-back-button"
                onClick={() => onSelectThread('')}
                title="Back to discussions"
                type="button"
              >
                <ArrowLeftIcon aria-hidden="true" size={16} />
                <span>Discussions</span>
              </button>
              <span className="review-chat-thread-anchor">
                {threadLabel(activeThread)}
                {activeThread.anchorStatus === 'outdated' ? ' · Outdated' : ''}
              </span>
            </header>
            <div className="review-chat-messages review-chat-scroll">
              {activeThread.posts.map((post, postIndex) => (
                <div className="review-post review-chat-message" key={post.postId}>
                  <div className="review-post-heading">
                    <ReviewAvatar post={post} />
                    <strong>{reviewAuthorName(post)}</strong>
                    <ReviewTime value={post.createdAt} />
                    <div className="review-post-heading-actions">
                      {postIndex === 0 && activeThread.anchor.startLine !== undefined ? (
                        <button
                          aria-label={`Go to Line ${activeThread.anchor.startLine}`}
                          className="review-thread-location"
                          onClick={() => {
                            (onNavigateToThread ?? onSelectThread)(activeThread.threadId);
                          }}
                          type="button"
                        >
                          Line {activeThread.anchor.startLine}
                        </button>
                      ) : null}
                      {post.deletedAt === null &&
                      post.hiddenAt === null &&
                      ((activeThread.resolvedAt === null &&
                        post.permissions.canEdit &&
                        onEditPost !== undefined) ||
                        (post.permissions.canDelete && onDeletePost !== undefined)) ? (
                        <DropdownMenu>
                          <DropdownMenu.Trigger
                            render={
                              <button
                                aria-label="Comment actions"
                                className="review-post-menu-trigger"
                                title="Comment actions"
                                type="button"
                              >
                                <DotsThreeIcon aria-hidden="true" size={17} weight="bold" />
                              </button>
                            }
                          />
                          <DropdownMenu.Content align="end">
                            {activeThread.resolvedAt === null &&
                            post.permissions.canEdit &&
                            onEditPost ? (
                              <DropdownMenu.Item
                                onClick={() => {
                                  setEditingPostId(post.postId);
                                }}
                              >
                                Edit comment
                              </DropdownMenu.Item>
                            ) : null}
                            {post.permissions.canDelete && onDeletePost ? (
                              <DropdownMenu.Item
                                onClick={() => setDeleteConfirmPostId(post.postId)}
                                variant="danger"
                              >
                                Delete comment
                              </DropdownMenu.Item>
                            ) : null}
                          </DropdownMenu.Content>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </div>
                  {post.hiddenAt !== null ? (
                    <div className="review-hidden-post">
                      <span className="review-thread-badge">Hidden</span>
                      <ReviewBody
                        body={
                          moderator
                            ? post.deletedAt === null
                              ? post.body
                              : 'Comment deleted'
                            : 'Comment hidden by a moderator'
                        }
                      />
                    </div>
                  ) : editingPostId === post.postId ? (
                    <ReviewEditComposer
                      disabled={saving}
                      initialBody={post.body}
                      onCancel={() => setEditingPostId(undefined)}
                      onSubmit={(body) =>
                        runAction(async () => {
                          await onEditPost?.(post.postId, body);
                          setEditingPostId(undefined);
                        })
                      }
                      post={post}
                    />
                  ) : (
                    <ReviewBody body={post.deletedAt === null ? post.body : 'Comment deleted'} />
                  )}
                  {deleteConfirmPostId === post.postId && onDeletePost ? (
                    <div className="review-delete-confirm">
                      <span>Delete this comment? This cannot be undone.</span>
                      <div>
                        <button
                          className="review-button review-button-quiet"
                          onClick={() => setDeleteConfirmPostId(undefined)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className="review-button review-button-danger"
                          disabled={saving}
                          onClick={() =>
                            void runAction(async () => {
                              await onDeletePost(post.postId);
                              setDeleteConfirmPostId(undefined);
                            })
                          }
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {moderator &&
                  post.author.kind === 'visitor' &&
                  post.permissions.canModerate &&
                  onModeratePost ? (
                    <div className="review-post-controls">
                      <button
                        className="review-post-action"
                        disabled={saving}
                        onClick={() =>
                          void runAction(() =>
                            onModeratePost(post.postId, post.hiddenAt === null ? 'hide' : 'unhide'),
                          )
                        }
                        type="button"
                      >
                        {post.hiddenAt === null ? 'Hide visitor post' : 'Unhide visitor post'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {activeThread.resolvedAt !== null ? (
              <div className="review-thread-actions review-chat-footer">
                {activeThread.permissions.canReopen ? (
                  <button
                    className="review-button review-button-quiet"
                    disabled={saving}
                    onClick={() =>
                      void runAction(() => onSetThreadStatus(activeThread.threadId, 'reopen'))
                    }
                    type="button"
                  >
                    Unresolve discussion
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="review-thread-actions review-chat-footer">
                {activeThread.permissions.canReply ? (
                  <ReviewComposer
                    disabled={saving}
                    docked
                    moderator={moderator}
                    onSubmit={(body) => onReply(activeThread.threadId, body)}
                    placeholder="Reply to this discussion…"
                  />
                ) : (
                  <p className="review-thread-resolved">Replies are disabled for this link.</p>
                )}
                {activeThread.permissions.canResolve ? (
                  <button
                    className="review-button review-button-quiet"
                    disabled={saving}
                    onClick={() =>
                      void runAction(() => onSetThreadStatus(activeThread.threadId, 'resolve'))
                    }
                    type="button"
                  >
                    Resolve thread
                  </button>
                ) : null}
              </div>
            )}
          </section>
        ) : (
          <>
            <div className="review-chat-inbox review-chat-scroll">
              {visibleThreadCount === 0 ? (
                <p className="review-empty">{emptyMessage}</p>
              ) : (
                threadGroups.map(renderThreadGroup)
              )}
              {nextCursor !== null && onLoadOlder ? (
                <button
                  className="review-button review-button-quiet review-load-older"
                  disabled={loadingOlder}
                  onClick={() => void onLoadOlder()}
                  type="button"
                >
                  {loadingOlder ? 'Loading older discussions…' : 'Load older discussions'}
                </button>
              ) : null}
            </div>
            {newAnchor ? (
              <div className="review-chat-footer review-chat-new-thread">
                {selectedPath !== undefined ? (
                  <p className="review-composer-context">
                    Comment on <strong title={selectedPath}>{selectedPath}</strong>
                  </p>
                ) : null}
                <ReviewComposer
                  disabled={saving}
                  docked
                  moderator={moderator}
                  onSubmit={(body) => onCreateThread(newAnchor, body)}
                  placeholder="Start a discussion…"
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
  return (
    <aside aria-label="Discussion" className={panelClassName}>
      {collapsible ? (
        <div className="review-sidebar-content" hidden={collapsed} id={sidebarControlsId}>
          {panelContent}
        </div>
      ) : (
        panelContent
      )}
    </aside>
  );
}
