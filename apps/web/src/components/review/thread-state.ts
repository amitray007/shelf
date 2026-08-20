import type { CommentPost, CommentThread } from '@shelf/contracts';

export interface CommentPostThreadTransition {
  readonly threads: readonly CommentThread[];
  readonly removedThreadId?: string;
}

export function applyCommentPostTransition(
  threads: readonly CommentThread[],
  result: CommentPost,
): CommentPostThreadTransition {
  const existing = threads.find((thread) => thread.threadId === result.threadId);
  const removesRoot = result.deletedAt !== null && existing?.posts[0]?.postId === result.postId;
  if (removesRoot) {
    return {
      threads: threads.filter((thread) => thread.threadId !== result.threadId),
      removedThreadId: result.threadId,
    };
  }
  return {
    threads: threads.map((thread) =>
      thread.threadId !== result.threadId
        ? thread
        : {
            ...thread,
            posts: thread.posts.map((post) => (post.postId === result.postId ? result : post)),
          },
    ),
  };
}
