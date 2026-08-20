import type { CommentAnchor, CommentPolicy, CommentPost, CommentThread } from '@shelf/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createViewerCommentReply,
  createViewerCommentThread,
  loadViewerComments,
  updateViewerCommentPost,
  updateViewerCommentThread,
  type ViewerAuthority,
  ViewerCommentRevisionMismatchError,
} from '../../api.js';
import type { FileShareResolution, FolderShareResolution } from '../../share-types.js';
import { canWriteReview, readReviewVisitorIdentity } from './identity.js';
import {
  type ReviewPersistenceKey,
  readReviewValue,
  removeReviewValue,
  writeReviewValue,
} from './persistence.js';
import type { ReviewActions, ReviewState } from './types.js';

type ReviewResolution = FileShareResolution | FolderShareResolution;

function messageForError(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'Could not save this review.';
}

export const REVISION_MISMATCH_MESSAGE =
  'This file was updated while you were writing. Your draft is still here; reload the latest revision and re-anchor it before posting.';

export function reviewStorageKey(resolution: ReviewResolution): ReviewPersistenceKey {
  return `shelf:review-${resolution.shareId}:${resolution.revision.revisionId}`;
}

export function reviewPanelStorageKey(resolution: ReviewResolution): ReviewPersistenceKey {
  return `${reviewStorageKey(resolution)}:panel`;
}

export function reviewSurfaceVisible(
  policy: CommentPolicy | undefined,
  threadCount: number,
): boolean {
  return policy === 'private' || policy === 'shared' || threadCount > 0;
}

function readActiveThread(resolution: ReviewResolution): string | undefined {
  const value = readReviewValue(reviewStorageKey(resolution));
  return value === null || value === '' ? undefined : value;
}

function saveActiveThread(resolution: ReviewResolution, threadId: string | undefined): void {
  if (threadId === undefined) removeReviewValue(reviewStorageKey(resolution));
  else writeReviewValue(reviewStorageKey(resolution), threadId);
}

export function useViewerReview(
  resolution: ReviewResolution,
  authority: ViewerAuthority,
  policy: CommentPolicy | undefined,
  onRevisionMismatch?: (anchor: CommentAnchor) => void,
): ReviewState & ReviewActions & { readonly enabled: boolean; readonly writable: boolean } {
  const writable = policy === 'private' || policy === 'shared';
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return readActiveThread(resolution);
  });
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError((current) => (current === REVISION_MISMATCH_MESSAGE ? current : undefined));
      try {
        const identity = readReviewVisitorIdentity();
        const value = await loadViewerComments(
          {
            resolution,
            authority,
            ...(canWriteReview(identity) ? { visitorToken: identity.visitorToken } : {}),
          },
          signal,
        );
        if (signal?.aborted) return;
        setThreads(value.items);
        setNextCursor(value.nextCursor);
        setActiveThreadId((current) =>
          current !== undefined && value.items.some((thread) => thread.threadId === current)
            ? current
            : undefined,
        );
      } catch (cause) {
        if (signal?.aborted) return;
        setError(messageForError(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [authority, resolution],
  );

  const loadOlder = useCallback(async () => {
    if (nextCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const identity = readReviewVisitorIdentity();
      const value = await loadViewerComments({
        resolution,
        authority,
        cursor: nextCursor,
        ...(canWriteReview(identity) ? { visitorToken: identity.visitorToken } : {}),
      });
      setThreads((current) => {
        const byId = new Map(current.map((thread) => [thread.threadId, thread]));
        for (const thread of value.items) byId.set(thread.threadId, thread);
        return [...byId.values()];
      });
      setNextCursor(value.nextCursor);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setLoadingOlder(false);
    }
  }, [authority, loadingOlder, nextCursor, resolution]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const selectThread = useCallback(
    (threadId: string) => {
      const next = threadId === '' ? undefined : threadId;
      setActiveThreadId(next);
      saveActiveThread(resolution, next);
    },
    [resolution],
  );

  const mutate = useCallback(
    async (operation: () => Promise<CommentThread | undefined>) => {
      setSaving(true);
      setError(undefined);
      try {
        const result = await operation();
        if (result !== undefined) {
          setThreads((current) => {
            const existing = current.some((thread) => thread.threadId === result.threadId);
            return existing
              ? current.map((thread) => (thread.threadId === result.threadId ? result : thread))
              : [result, ...current];
          });
          selectThread(result.threadId);
        } else {
          await refresh();
        }
      } catch (cause) {
        if (cause instanceof ViewerCommentRevisionMismatchError) {
          await refresh();
        }
        setError(messageForError(cause));
        throw cause;
      } finally {
        setSaving(false);
      }
    },
    [refresh, selectThread],
  );

  const createThread = useCallback(
    async (anchor: CommentAnchor, body: string) => {
      const identity = readReviewVisitorIdentity();
      if (!canWriteReview(identity))
        throw new Error('Secure browser identity is unavailable. Comments cannot be saved.');
      try {
        await mutate(async () =>
          createViewerCommentThread({
            resolution,
            authority,
            visitorToken: identity.visitorToken,
            displayName: identity.displayName,
            anchor,
            body,
          }),
        );
      } catch (cause) {
        if (cause instanceof ViewerCommentRevisionMismatchError) onRevisionMismatch?.(anchor);
        throw cause;
      }
    },
    [authority, mutate, onRevisionMismatch, resolution],
  );

  const reply = useCallback(
    async (threadId: string, body: string) => {
      const identity = readReviewVisitorIdentity();
      if (!canWriteReview(identity))
        throw new Error('Secure browser identity is unavailable. Comments cannot be saved.');
      await mutate(async () => {
        await createViewerCommentReply({
          resolution,
          authority,
          visitorToken: identity.visitorToken,
          displayName: identity.displayName,
          threadId,
          body,
        });
        return undefined;
      });
    },
    [authority, mutate, resolution],
  );

  const setThreadStatus = useCallback(
    async (threadId: string, status: 'resolve' | 'reopen') => {
      const identity = readReviewVisitorIdentity();
      if (!canWriteReview(identity))
        throw new Error('Secure browser identity is unavailable. Comments cannot be saved.');
      await mutate(async () =>
        updateViewerCommentThread({
          resolution,
          authority,
          visitorToken: identity.visitorToken,
          displayName: identity.displayName,
          threadId,
          status,
        }),
      );
    },
    [authority, mutate, resolution],
  );

  const mutatePost = useCallback(async (operation: () => Promise<CommentPost>) => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await operation();
      setThreads((current) =>
        current.map((thread) =>
          thread.threadId !== result.threadId
            ? thread
            : {
                ...thread,
                posts: thread.posts.map((post) => (post.postId === result.postId ? result : post)),
              },
        ),
      );
    } catch (cause) {
      setError(messageForError(cause));
      throw cause;
    } finally {
      setSaving(false);
    }
  }, []);

  const editPost = useCallback(
    async (postId: string, body: string) => {
      const identity = readReviewVisitorIdentity();
      if (!canWriteReview(identity))
        throw new Error('Secure browser identity is unavailable. Comments cannot be saved.');
      await mutatePost(() =>
        updateViewerCommentPost({
          resolution,
          authority,
          visitorToken: identity.visitorToken,
          displayName: identity.displayName,
          postId,
          action: 'edit',
          body,
        }),
      );
    },
    [authority, mutatePost, resolution],
  );

  const deletePost = useCallback(
    async (postId: string) => {
      const identity = readReviewVisitorIdentity();
      if (!canWriteReview(identity))
        throw new Error('Secure browser identity is unavailable. Comments cannot be saved.');
      await mutatePost(() =>
        updateViewerCommentPost({
          resolution,
          authority,
          visitorToken: identity.visitorToken,
          displayName: identity.displayName,
          postId,
          action: 'delete',
        }),
      );
    },
    [authority, mutatePost, resolution],
  );

  const enabled = reviewSurfaceVisible(policy, threads.length);

  return useMemo(
    () => ({
      enabled,
      writable,
      threads,
      loadingOlder,
      nextCursor,
      activeThreadId,
      loading,
      saving,
      ...(error === undefined ? {} : { error }),
      refresh,
      loadOlder,
      selectThread,
      createThread,
      reply,
      setThreadStatus,
      editPost,
      deletePost,
    }),
    [
      activeThreadId,
      createThread,
      deletePost,
      editPost,
      enabled,
      error,
      loading,
      loadingOlder,
      loadOlder,
      nextCursor,
      refresh,
      reply,
      saving,
      selectThread,
      setThreadStatus,
      threads,
      writable,
    ],
  );
}
