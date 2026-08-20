import type { CommentAnchor, CommentThread } from '@shelf/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReviewAvatar, ReviewBody, ReviewThreadCard } from './comment-card.js';
import { readReviewVisitorIdentity } from './identity.js';
import { VisitorNameDialog } from './identity-dialog.js';
import { ReviewSidebarToolbar } from './sidebar-toolbar.js';

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
  readonly emptyLabel?: string | undefined;
  readonly selectedPath?: string | undefined;
  readonly newAnchor?: CommentAnchor | undefined;
}

export function ReviewComposer({
  disabled = false,
  moderator = false,
  onSubmit,
  placeholder = 'Add a note…',
}: {
  readonly disabled?: boolean;
  readonly moderator?: boolean;
  readonly onSubmit: (body: string) => Promise<void>;
  readonly placeholder?: string;
}) {
  const [body, setBody] = useState('');
  const [nameDialog, setNameDialog] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (body.trim().length === 0 || pending) return;
    if (!moderator && readReviewVisitorIdentity().displayName.trim().length === 0) {
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
    setNameDialog(false);
    void submit();
  };
  return (
    <>
      <div className="review-composer">
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
          rows={3}
          value={body}
        />
        <div className="review-composer-footer">
          <span>Markdown-lite · ⌘↵ to send</span>
          <button
            className="review-button review-button-primary"
            disabled={disabled || pending || body.trim() === ''}
            onClick={() => void submit()}
            type="button"
          >
            {pending ? 'Saving…' : 'Comment'}
          </button>
        </div>
        {error ? (
          <span aria-live="assertive" className="review-status review-status-error">
            {error}
          </span>
        ) : null}
      </div>
      {nameDialog ? (
        <VisitorNameDialog onCancel={() => setNameDialog(false)} onSaved={continueWithName} />
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
}: DiscussionPanelProps) {
  const [query, setQuery] = useState('');
  const [localSearchOpen, setLocalSearchOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [editingPostId, setEditingPostId] = useState<string>();
  const [editBody, setEditBody] = useState('');
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState<string>();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const activeThread = threads.find((thread) => thread.threadId === activeThreadId);
  const searchOpen = controlledSearchOpen ?? localSearchOpen;
  const toggleSearch = onSearchToggle ?? (() => setLocalSearchOpen((open) => !open));
  const filteredThreads = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return threads;
    return threads.filter((thread) => {
      const text = thread.posts.map((post) => post.body).join(' ');
      return `${threadLabel(thread)} ${text}`.toLowerCase().includes(normalized);
    });
  }, [query, threads]);
  useEffect(() => {
    if (activeThreadId !== undefined) replyRef.current?.focus();
  }, [activeThreadId]);
  const runAction = async (action: () => Promise<void>) => {
    setActionError(undefined);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not save this review.');
    }
  };
  return (
    <aside aria-label="Discussion" className="review-panel">
      {showToolbar ? (
        <ReviewSidebarToolbar
          onClose={onClose}
          onSearchToggle={toggleSearch}
          searchOpen={searchOpen}
        />
      ) : null}
      {!moderator ? (
        <button
          className="review-identity-button"
          onClick={() => setNameDialog(true)}
          type="button"
        >
          <img
            alt=""
            className="review-avatar"
            height={24}
            src="https://api.dicebear.com/9.x/initials/svg?seed=visitor"
            width={24}
          />
          <span>{readReviewVisitorIdentity().displayName || 'Add your name'}</span>
        </button>
      ) : null}
      {searchOpen ? (
        <input
          aria-label="Search discussions"
          className="review-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search discussions"
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
      {nameDialog && !moderator ? (
        <VisitorNameDialog
          onCancel={() => setNameDialog(false)}
          onSaved={() => setNameDialog(false)}
        />
      ) : null}
      <div className="review-panel-body">
        {activeThread ? (
          <section className="review-thread-detail">
            <button className="review-back-button" onClick={() => onSelectThread('')} type="button">
              ← All discussions
            </button>
            <div className="review-thread-location">
              {threadLabel(activeThread)}
              {activeThread.anchorStatus === 'outdated' ? ' · Outdated' : ''}
            </div>
            {activeThread.posts.map((post) => (
              <div className="review-post" key={post.postId}>
                <div className="review-post-heading">
                  <ReviewAvatar post={post} />
                  <strong>
                    {post.author.kind === 'visitor' ? post.author.displayName : 'Shelf team'}
                  </strong>
                  <time dateTime={post.createdAt}>
                    {new Date(post.createdAt).toLocaleDateString()}
                  </time>
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
                  <div className="review-post-editor">
                    <textarea
                      aria-label="Edit comment"
                      maxLength={20_000}
                      onChange={(event) => setEditBody(event.target.value)}
                      rows={3}
                      value={editBody}
                    />
                    <div className="review-post-controls">
                      <button
                        className="review-button review-button-quiet"
                        onClick={() => setEditingPostId(undefined)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="review-button review-button-primary"
                        disabled={saving || editBody.trim() === ''}
                        onClick={() =>
                          void runAction(async () => {
                            await onEditPost?.(post.postId, editBody.trim());
                            setEditingPostId(undefined);
                          })
                        }
                        type="button"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <ReviewBody body={post.deletedAt === null ? post.body : 'Comment deleted'} />
                )}
                {post.deletedAt === null &&
                post.hiddenAt === null &&
                (!moderator || post.author.kind !== 'visitor') &&
                (post.permissions.canEdit || post.permissions.canDelete) ? (
                  <div className="review-post-controls">
                    {post.permissions.canEdit && onEditPost ? (
                      <button
                        className="review-post-action"
                        onClick={() => {
                          setEditingPostId(post.postId);
                          setEditBody(post.body);
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                    ) : null}
                    {post.permissions.canDelete && onDeletePost ? (
                      deleteConfirmPostId === post.postId ? (
                        <>
                          <span className="review-delete-confirm">Delete this comment?</span>
                          <button
                            className="review-post-action review-post-action-danger"
                            onClick={() =>
                              void runAction(async () => {
                                await onDeletePost(post.postId);
                                setDeleteConfirmPostId(undefined);
                              })
                            }
                            type="button"
                          >
                            Confirm
                          </button>
                          <button
                            className="review-post-action"
                            onClick={() => setDeleteConfirmPostId(undefined)}
                            type="button"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="review-post-action"
                          onClick={() => setDeleteConfirmPostId(post.postId)}
                          type="button"
                        >
                          Delete
                        </button>
                      )
                    ) : null}
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
            {activeThread.resolvedAt !== null ? (
              <div className="review-thread-actions">
                <p className="review-thread-resolved">Resolved</p>
                {activeThread.permissions.canReopen ? (
                  <button
                    className="review-button review-button-quiet"
                    disabled={saving}
                    onClick={() =>
                      void runAction(() => onSetThreadStatus(activeThread.threadId, 'reopen'))
                    }
                    type="button"
                  >
                    Reopen thread
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="review-thread-actions">
                {activeThread.permissions.canReply ? (
                  <ReviewComposer
                    disabled={saving}
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
            {filteredThreads.length === 0 ? (
              <p className="review-empty">{emptyLabel}</p>
            ) : (
              filteredThreads.map((thread) => (
                <button
                  className="review-thread-button"
                  key={thread.threadId}
                  onClick={() => onSelectThread(thread.threadId)}
                  type="button"
                >
                  <ReviewThreadCard location={threadLabel(thread)} thread={thread} />
                </button>
              ))
            )}
            {selectedPath !== undefined ? (
              <p className="review-selected-path">
                New comments on <strong>{selectedPath}</strong> can be attached from the file.
              </p>
            ) : null}
            {newAnchor ? (
              <ReviewComposer
                disabled={saving}
                moderator={moderator}
                onSubmit={(body) => onCreateThread(newAnchor, body)}
                placeholder="Start a discussion…"
              />
            ) : null}
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
          </>
        )}
      </div>
    </aside>
  );
}
