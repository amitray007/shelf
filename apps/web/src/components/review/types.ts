import type { CommentAnchor, CommentThread } from '@shelf/contracts';

export type ReviewSidebarMode = 'tree' | 'discussion';
export type ReviewThreadFilter = 'all' | 'unresolved' | 'resolved';
export const REVIEW_THREAD_FILTERS = [
  { value: 'all', label: 'All discussions' },
  { value: 'unresolved', label: 'Unresolved' },
  { value: 'resolved', label: 'Resolved' },
] as const satisfies readonly { value: ReviewThreadFilter; label: string }[];

export interface ReviewState {
  readonly threads: readonly CommentThread[];
  readonly activeThreadId?: string | undefined;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly nextCursor: string | null;
  readonly saving: boolean;
  readonly error?: string | undefined;
}

export interface ReviewActions {
  readonly selectThread: (threadId: string) => void;
  readonly createThread: (anchor: CommentAnchor, body: string) => Promise<void>;
  readonly reply: (threadId: string, body: string) => Promise<void>;
  readonly setThreadStatus: (threadId: string, status: 'resolve' | 'reopen') => Promise<void>;
  readonly editPost: (postId: string, body: string) => Promise<void>;
  readonly deletePost: (postId: string) => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly loadOlder: () => Promise<void>;
}
