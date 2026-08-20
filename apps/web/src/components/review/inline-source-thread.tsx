import type { CommentPost } from '@shelf/contracts';
import { useState } from 'react';
import { ReviewAvatar, ReviewBody, ReviewTime, reviewAuthorName } from './comment-card.js';
import { ReviewEditComposer } from './edit-composer.js';

export const SOURCE_INLINE_COMMENT_LIMIT = 5;

export interface InlineSourceThreadData {
  readonly expanded: boolean;
  readonly label: string;
  readonly participantPosts: readonly CommentPost[];
  readonly posts: readonly CommentPost[];
}

export interface InlineSourceThreadProps {
  readonly data: InlineSourceThreadData;
  readonly lineNumber: number;
  readonly onAnnotationToggle?: (() => void) | undefined;
  readonly onDeletePost?: ((postId: string) => Promise<void>) | undefined;
  readonly onEditPost?: ((postId: string, body: string) => Promise<void>) | undefined;
  readonly saving?: boolean | undefined;
}

export function InlineSourceThread({
  data,
  lineNumber,
  onAnnotationToggle,
  onDeletePost,
  onEditPost,
  saving = false,
}: InlineSourceThreadProps) {
  const [editingPostId, setEditingPostId] = useState<string>();
  const [deleteConfirmPostId, setDeleteConfirmPostId] = useState<string>();
  const [postActionPending, setPostActionPending] = useState(false);
  const [postActionError, setPostActionError] = useState<
    { readonly message: string; readonly postId: string } | undefined
  >();

  const saveInlineEdit = async (postId: string, body: string) => {
    if (onEditPost === undefined || body.trim() === '' || postActionPending || saving) return;
    setPostActionPending(true);
    setPostActionError(undefined);
    try {
      await onEditPost(postId, body.trim());
      setEditingPostId(undefined);
    } catch (cause) {
      setPostActionError({
        message: cause instanceof Error ? cause.message : 'Could not save this comment.',
        postId,
      });
    } finally {
      setPostActionPending(false);
    }
  };

  const deleteInlinePost = async (postId: string) => {
    if (onDeletePost === undefined || postActionPending || saving) return;
    setPostActionPending(true);
    setPostActionError(undefined);
    try {
      await onDeletePost(postId);
      setDeleteConfirmPostId(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not delete this comment.';
      setPostActionError({ message, postId });
    } finally {
      setPostActionPending(false);
    }
  };

  return (
    <div className="pierre-inline-thread">
      <button
        aria-expanded={data.expanded}
        aria-label={`${data.expanded ? 'Hide' : 'Show'} ${data.label} on line ${lineNumber}`}
        className="pierre-inline-thread-trigger"
        onClick={onAnnotationToggle}
        type="button"
      >
        <span aria-hidden="true" className="pierre-inline-avatar-stack">
          {data.participantPosts.slice(0, 3).map((post) => (
            <ReviewAvatar key={post.author.participantId} post={post} size={20} />
          ))}
        </span>
        <span>{data.label}</span>
      </button>
      {data.expanded ? (
        <div className="pierre-inline-thread-card">
          <div className="pierre-inline-thread-heading">
            <strong>Line {lineNumber}</strong>
            <span>{data.label}</span>
          </div>
          <div
            className="pierre-inline-messages"
            data-scrollable={data.posts.length > SOURCE_INLINE_COMMENT_LIMIT ? 'true' : undefined}
          >
            {data.posts.map((post) => (
              <article className="pierre-inline-message" key={post.postId}>
                <ReviewAvatar post={post} size={24} />
                <div className="pierre-inline-message-content">
                  <div className="pierre-inline-message-heading">
                    <strong>{reviewAuthorName(post)}</strong>
                    <ReviewTime value={post.createdAt} />
                  </div>
                  {editingPostId === post.postId ? (
                    <ReviewEditComposer
                      compact
                      disabled={postActionPending || saving}
                      initialBody={post.body}
                      onCancel={() => setEditingPostId(undefined)}
                      onSubmit={(body) => saveInlineEdit(post.postId, body)}
                      post={post}
                      wrapperClassName="pierre-inline-edit-composer"
                    />
                  ) : (
                    <ReviewBody
                      body={
                        post.deletedAt !== null
                          ? 'Comment deleted'
                          : post.hiddenAt !== null
                            ? 'Comment hidden'
                            : post.body
                      }
                    />
                  )}
                  {post.deletedAt === null &&
                  post.hiddenAt === null &&
                  ((post.permissions.canEdit && onEditPost !== undefined) ||
                    (post.permissions.canDelete && onDeletePost !== undefined)) ? (
                    <div className="pierre-inline-message-actions">
                      {post.permissions.canEdit && onEditPost !== undefined ? (
                        <button
                          aria-label="Edit comment"
                          onClick={() => {
                            setEditingPostId(post.postId);
                            setPostActionError(undefined);
                          }}
                          type="button"
                        >
                          Edit
                        </button>
                      ) : null}
                      {post.permissions.canDelete && onDeletePost !== undefined ? (
                        <button
                          aria-label="Delete comment"
                          onClick={() => setDeleteConfirmPostId(post.postId)}
                          type="button"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {deleteConfirmPostId === post.postId && onDeletePost !== undefined ? (
                    <div className="pierre-inline-delete-confirm">
                      <span>Delete this comment?</span>
                      <button onClick={() => setDeleteConfirmPostId(undefined)} type="button">
                        Cancel
                      </button>
                      <button
                        disabled={postActionPending || saving}
                        onClick={() => void deleteInlinePost(post.postId)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                  {postActionError?.postId === post.postId ? (
                    <span aria-live="assertive" className="review-status review-status-error">
                      {postActionError.message}
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
