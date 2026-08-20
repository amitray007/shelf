import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  COMMENT_SUMMARY_RECENT_THREAD_LIMIT,
  CommentAnchorSchema,
  CommentSummarySchema,
  CommentThreadSchema,
  isCommentAnchor,
  isCommentPost,
  isCommentThread,
} from '../src/index.js';

const revisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';

describe('comment contracts', () => {
  it('accepts file/range anchor shapes; ordered-range validation belongs to core', () => {
    const file = { revisionId, kind: 'file' };
    const range = {
      revisionId,
      path: 'src/index.ts',
      kind: 'range',
      startLine: 2,
      endLine: 4,
      quotedText: 'hello',
    };
    expect(Check(CommentAnchorSchema, file)).toBe(true);
    expect(Check(CommentAnchorSchema, range)).toBe(true);
    expect(isCommentAnchor(range)).toBe(true);
    expect(Check(CommentAnchorSchema, { ...range, startLine: 5, endLine: 2 })).toBe(true);
  });

  it('bounds thread bodies and batched participant summaries', () => {
    const thread = {
      threadId: 'thd_1',
      workspaceId: 'workspace-main',
      artifactId: 'art_BBBBBBBBBBBBBBBBBBBBBB',
      shareId: 'shr_CCCCCCCCCCCCCCCCCCCCCC',
      revisionId,
      visibility: 'shared',
      anchor: { revisionId, kind: 'file' },
      anchorStatus: 'exact',
      resolvedAt: null,
      createdAt: '2026-08-19T11:00:00.000Z',
      updatedAt: '2026-08-19T11:00:00.000Z',
      permissions: { canReply: true, canResolve: true, canReopen: false },
      posts: [
        {
          postId: 'pst_1',
          threadId: 'thd_1',
          body: 'hello',
          author: { kind: 'visitor', participantId: 'pt_a', displayName: 'A' },
          permissions: { canEdit: true, canDelete: true, canModerate: false },
          createdAt: '2026-08-19T11:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
      ],
    };
    expect(Check(CommentThreadSchema, thread)).toBe(true);
    expect(isCommentThread(thread)).toBe(true);
    expect(isCommentPost(thread.posts[0])).toBe(true);
    expect(isCommentPost({ ...thread.posts[0], permissions: undefined })).toBe(false);
    expect(
      Check(CommentThreadSchema, { ...thread, posts: [{ ...thread.posts[0], body: '' }] }),
    ).toBe(false);
    expect(
      Check(CommentSummarySchema, {
        artifactId: thread.artifactId,
        participantCount: 1,
        participants: [
          {
            participantId: 'pt_a',
            displayName: 'A',
            threadCount: 1,
            replyCount: 0,
            latestThreadId: 'thd_1',
            latestActivityAt: thread.createdAt,
            recentThreads: [{ threadId: 'thd_1', latestActivityAt: thread.createdAt }],
          },
        ],
        openThreadCount: 1,
        openReplyCount: 0,
        latestActivityAt: thread.createdAt,
        latestThreadId: 'thd_1',
      }),
    ).toBe(true);

    const recentThreads = Array.from(
      { length: COMMENT_SUMMARY_RECENT_THREAD_LIMIT },
      (_, index) => ({
        threadId: `thd_${index + 1}`,
        latestActivityAt: `2026-08-19T11:${String(index).padStart(2, '0')}:00.000Z`,
      }),
    );
    const summary = {
      artifactId: thread.artifactId,
      participantCount: 1,
      participants: [
        {
          participantId: 'pt_a',
          displayName: 'A',
          threadCount: COMMENT_SUMMARY_RECENT_THREAD_LIMIT,
          replyCount: 0,
          latestThreadId: 'thd_1',
          latestActivityAt: recentThreads[0]?.latestActivityAt ?? thread.createdAt,
          recentThreads,
        },
      ],
      openThreadCount: COMMENT_SUMMARY_RECENT_THREAD_LIMIT,
      openReplyCount: 0,
      latestActivityAt: recentThreads[0]?.latestActivityAt ?? thread.createdAt,
      latestThreadId: 'thd_1',
    };
    expect(Check(CommentSummarySchema, summary)).toBe(true);
    expect(
      Check(CommentSummarySchema, {
        ...summary,
        participants: [
          {
            ...summary.participants[0],
            recentThreads: [...recentThreads, ...recentThreads.slice(0, 1)],
          },
        ],
      }),
    ).toBe(false);
  });
});
