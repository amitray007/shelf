import { ArrowUpIcon } from '@phosphor-icons/react/ArrowUp';
import { XIcon } from '@phosphor-icons/react/X';
import type { CommentPost } from '@shelf/contracts';
import { useEffect, useRef, useState } from 'react';
import { ReviewAvatar } from './comment-card.js';

export interface ReviewEditComposerProps {
  readonly compact?: boolean;
  readonly disabled?: boolean;
  readonly initialBody: string;
  readonly onCancel: () => void;
  readonly onSubmit: (body: string) => Promise<void>;
  readonly post: CommentPost;
  readonly wrapperClassName?: string;
}

/**
 * Shared edit shell for discussion posts and inline source comments.
 *
 * The parent owns post-scoped actions (including delete confirmation and
 * errors); this component only owns the draft, keyboard shortcuts, and its
 * pending state.
 */
export function ReviewEditComposer({
  compact = false,
  disabled = false,
  initialBody,
  onCancel,
  onSubmit,
  post,
  wrapperClassName,
}: ReviewEditComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [pending, setPending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    if (body.trim() === '' || pending || disabled) return;
    setPending(true);
    try {
      await onSubmit(body.trim());
    } finally {
      setPending(false);
    }
  };

  const wrapperClass = [
    'review-composer',
    compact ? undefined : 'review-composer-docked',
    compact ? undefined : 'review-composer-edit',
    wrapperClassName,
  ]
    .filter(Boolean)
    .join(' ');
  const cancelDisabled = pending && !compact;

  return (
    <div className={wrapperClass}>
      <div className="review-composer-input">
        {!compact ? (
          <span className="review-composer-avatar review-composer-avatar-static">
            <ReviewAvatar post={post} size={36} />
          </span>
        ) : null}
        <textarea
          aria-label="Edit comment"
          disabled={disabled || pending}
          maxLength={20_000}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          ref={textareaRef}
          rows={1}
          value={body}
        />
        <div className={compact ? 'pierre-inline-edit-actions' : 'review-composer-actions'}>
          <button
            aria-label="Cancel editing comment"
            className="review-composer-cancel"
            disabled={cancelDisabled}
            onClick={onCancel}
            title="Cancel edit (Esc)"
            type="button"
          >
            <XIcon aria-hidden="true" size={compact ? 14 : 15} weight="bold" />
          </button>
          <button
            aria-label="Save edited comment"
            className="review-composer-submit"
            disabled={disabled || pending || body.trim() === ''}
            onClick={() => void submit()}
            title="Save edit (⌘↵)"
            type="button"
          >
            <ArrowUpIcon aria-hidden="true" size={compact ? 16 : 17} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
