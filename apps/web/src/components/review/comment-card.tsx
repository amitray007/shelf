import type { CommentPost, CommentThread } from '@shelf/contracts';
import type { MouseEvent } from 'react';

export interface ReviewParticipant {
  readonly participantId: string;
  readonly displayName: string;
  readonly threadCount: number;
  readonly replyCount: number;
}

function avatarSeed(post: CommentPost): string {
  return post.author.participantId;
}

function authorName(post: CommentPost): string {
  return post.author.kind === 'visitor' ? post.author.displayName : 'Shelf team';
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
      alt={`${authorName(post)} avatar`}
      className="review-avatar"
      height={size}
      src={`https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(avatarSeed(post))}`}
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
        src={`https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(participant.participantId)}`}
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
  thread,
}: {
  readonly compact?: boolean;
  readonly thread: CommentThread;
}) {
  const first = thread.posts[0];
  if (first === undefined) return null;
  const body = first.deletedAt === null ? first.body : 'Comment deleted';
  return (
    <article
      aria-label={`Discussion started by ${authorName(first)}`}
      className={`review-thread-card${compact ? ' review-thread-card-compact' : ''}${thread.resolvedAt === null ? '' : ' review-thread-resolved'}`}
    >
      <div className="review-thread-card-heading">
        <ReviewAvatar post={first} />
        <div className="review-thread-author">
          <strong>{authorName(first)}</strong>
          <time dateTime={first.createdAt}>{new Date(first.createdAt).toLocaleDateString()}</time>
        </div>
        {thread.anchorStatus === 'outdated' ? (
          <span className="review-thread-badge">Outdated</span>
        ) : null}
      </div>
      <ReviewBody body={body} />
      {!compact && thread.posts.length > 1 ? (
        <span className="review-thread-replies">{thread.posts.length - 1} replies</span>
      ) : null}
    </article>
  );
}
