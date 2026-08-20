import { CheckIcon } from '@phosphor-icons/react/Check';
import type { CommentPost, CommentThread } from '@shelf/contracts';
import type { MouseEvent } from 'react';

export interface ReviewParticipant {
  readonly participantId: string;
  readonly displayName: string;
  readonly threadCount: number;
  readonly replyCount: number;
}

const REVIEW_TIME_UNITS = [
  { duration: 60 * 60 * 24 * 365, suffix: 'y' },
  { duration: 60 * 60 * 24 * 30, suffix: 'mo' },
  { duration: 60 * 60 * 24 * 7, suffix: 'w' },
  { duration: 60 * 60 * 24, suffix: 'd' },
  { duration: 60 * 60, suffix: 'h' },
  { duration: 60, suffix: 'm' },
] as const;

const REVIEW_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function reviewAuthorName(post: CommentPost): string {
  return post.author.kind === 'visitor' ? post.author.displayName : 'Shelf team';
}

export function reviewAvatarUrl(participantId: string): string {
  return `https://api.dicebear.com/9.x/notionists-neutral/svg?seed=${encodeURIComponent(participantId)}&backgroundColor=e4e4e7`;
}

function formatRelativeReviewTimestamp(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) return '';
  const elapsed = now - timestamp;
  const future = elapsed < 0;
  const seconds = Math.max(0, Math.floor(Math.abs(elapsed) / 1_000));
  if (seconds < 60) return future ? 'soon' : 'now';
  const unit =
    REVIEW_TIME_UNITS.find(({ duration }) => seconds >= duration) ?? REVIEW_TIME_UNITS.at(-1);
  if (unit === undefined) return '';
  const count = Math.max(1, Math.floor(seconds / unit.duration));
  return future ? `in ${count}${unit.suffix}` : `${count}${unit.suffix} ago`;
}

export function formatRelativeReviewTime(value: string, now = Date.now()): string {
  return formatRelativeReviewTimestamp(Date.parse(value), now);
}

export function ReviewTime({ value }: { readonly value: string }) {
  const timestamp = Date.parse(value);
  const title = Number.isFinite(timestamp) ? REVIEW_DATE_FORMAT.format(timestamp) : value;
  return (
    <time dateTime={value} title={title}>
      {formatRelativeReviewTimestamp(timestamp)}
    </time>
  );
}

export function ReviewAvatar({
  post,
  size = 28,
}: {
  readonly post: CommentPost;
  readonly size?: number;
}) {
  return (
    <img
      alt={`${reviewAuthorName(post)} avatar`}
      className="review-avatar"
      height={size}
      src={reviewAvatarUrl(post.author.participantId)}
      referrerPolicy="no-referrer"
      width={size}
    />
  );
}

export function ReviewParticipantAvatar({
  onClick,
  participant,
}: {
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly participant: ReviewParticipant;
}) {
  const activityLabel = `${participant.displayName}; ${participant.threadCount} ${participant.threadCount === 1 ? 'thread' : 'threads'}, ${participant.replyCount} ${participant.replyCount === 1 ? 'reply' : 'replies'}`;
  return (
    <button
      aria-label={activityLabel}
      className="review-participant-avatar"
      onClick={onClick}
      title={activityLabel}
      type="button"
    >
      <img
        alt={`${participant.displayName} avatar`}
        height={28}
        referrerPolicy="no-referrer"
        src={reviewAvatarUrl(participant.participantId)}
        width={28}
      />
    </button>
  );
}

export function ReviewBody({ body }: { readonly body: string }) {
  const keys = new Map<string, number>();
  const keyFor = (value: string) => {
    const count = keys.get(value) ?? 0;
    keys.set(value, count + 1);
    return `${value}:${count}`;
  };
  return (
    <div className="review-body">
      {body.split(/\r?\n/u).map((line) => (
        <p key={keyFor(`line:${line}`)}>
          {line.split(/(`[^`]+`|\*\*[^*]+\*\*)/u).map((part) => {
            const key = keyFor(`part:${part}`);
            if (part.startsWith('`') && part.endsWith('`'))
              return <code key={key}>{part.slice(1, -1)}</code>;
            if (part.startsWith('**') && part.endsWith('**'))
              return <strong key={key}>{part.slice(2, -2)}</strong>;
            return <span key={key}>{part}</span>;
          })}
        </p>
      ))}
    </div>
  );
}

export function ReviewThreadCard({
  compact = false,
  location,
  thread,
}: {
  readonly compact?: boolean;
  readonly location?: string | undefined;
  readonly thread: CommentThread;
}) {
  const first = thread.posts[0];
  if (first === undefined) return null;
  const body = first.deletedAt === null ? first.body : 'Comment deleted';
  return (
    <article
      aria-label={`Discussion started by ${reviewAuthorName(first)}`}
      className={`review-thread-card${compact ? ' review-thread-card-compact' : ''}`}
    >
      <div className="review-thread-card-heading">
        <span
          className="review-avatar-wrap"
          title={thread.resolvedAt !== null ? 'Resolved discussion' : undefined}
        >
          <ReviewAvatar post={first} />
          {thread.resolvedAt !== null ? (
            <span aria-label="Resolved discussion" className="review-resolved-indicator" role="img">
              <CheckIcon aria-hidden="true" size={9} weight="bold" />
            </span>
          ) : null}
        </span>
        <div className="review-thread-author">
          <strong>{reviewAuthorName(first)}</strong>
          <ReviewTime value={first.createdAt} />
        </div>
        {thread.anchorStatus === 'outdated' ? (
          <span className="review-thread-badge">Outdated</span>
        ) : null}
      </div>
      <ReviewBody body={body} />
      {!compact ? (
        <div className="review-thread-meta">
          {location !== undefined ? (
            <span className="review-thread-location">{location}</span>
          ) : null}
          {thread.posts.length > 1 ? (
            <span className="review-thread-replies">
              {thread.posts.length - 1} {thread.posts.length === 2 ? 'reply' : 'replies'}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
