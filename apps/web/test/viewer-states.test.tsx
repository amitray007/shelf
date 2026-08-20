import type { CommentThread, FolderEntry, PublicShareResolution } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArtifactContent } from '../src/components/artifact-content.js';
import {
  DEFAULT_SOURCE_VIEW_SETTINGS,
  FileLoadingState,
  FileView,
  groupSourceThreadsByLine,
  SourceView,
  sourceCommentsVisible,
  sourceLineSelectionEnabled,
  toggleSourceComments,
} from '../src/components/file-view.js';
import {
  FolderBrowser,
  folderFileViewKey,
  isFolderEntryVisible,
  isProgrammaticFolderSelection,
  shouldApplyFolderFocusRequest,
} from '../src/components/folder-browser.js';
import {
  formatRelativeReviewTime,
  ReviewAvatar,
  reviewAvatarUrl,
} from '../src/components/review/comment-card.js';
import { DiscussionPanel, ReviewEditComposer } from '../src/components/review/discussion-panel.js';
import { InlineSourceThread } from '../src/components/review/inline-source-thread.js';
import { ReviewSidebarToolbar } from '../src/components/review/sidebar-toolbar.js';
import { applyCommentPostTransition } from '../src/components/review/thread-state.js';
import { REVIEW_THREAD_FILTERS } from '../src/components/review/types.js';
import {
  reviewPanelStorageKey,
  reviewSurfaceVisible,
} from '../src/components/review/use-review.js';
import { UnavailableView, ViewerRail } from '../src/components/viewer-shell.js';
import {
  clampViewerSidebarWidth,
  readViewerSidebarWidth,
  VIEWER_SIDEBAR_WIDTH_STORAGE_KEY,
  ViewerSidebarSplit,
  viewerSidebarBounds,
} from '../src/components/viewer-sidebar-split.js';
import { readViewerSidebarOpen } from '../src/viewer-page.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function reviewTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const FILE_RESOLUTION = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  accessType: 'protected',
  target: { mode: 'latest' },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'file', name: 'idea.md' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 3,
    createdAt: '2026-08-18T10:00:00.000Z',
    kind: 'file',
    originalFileName: 'idea.md',
    mediaType: 'text/markdown',
    byteCount: 42,
  },
  action: {
    type: 'content',
    path: `/api/v1/public/shares/shr_${'a'.repeat(22)}/content`,
  },
} satisfies PublicShareResolution;

const FOLDER_RESOLUTION = {
  apiVersion: 'v1',
  shareId: `shr_${'a'.repeat(22)}`,
  accessType: 'protected',
  target: { mode: 'pinned', revisionId: `rev_${'c'.repeat(22)}` },
  expiresAt: null,
  artifact: { artifactId: `art_${'b'.repeat(22)}`, kind: 'folder', name: 'ideas' },
  revision: {
    revisionId: `rev_${'c'.repeat(22)}`,
    revisionNumber: 3,
    createdAt: '2026-08-18T10:00:00.000Z',
    kind: 'folder',
    rootName: 'ideas',
    byteCount: 42,
    fileCount: 1,
  },
  action: {
    type: 'tree',
    path: `/api/v1/public/shares/shr_${'a'.repeat(22)}/tree`,
  },
} satisfies PublicShareResolution;

function renderContent(props: Partial<React.ComponentProps<typeof ArtifactContent>> = {}): string {
  return renderToStaticMarkup(
    <ArtifactContent
      authority={{
        accessType: 'protected',
        shareId: FILE_RESOLUTION.shareId,
        sessionId: '123e4567-e89b-42d3-a456-426614174000',
        token: `${'v'.repeat(24)}.${'s'.repeat(43)}`,
      }}
      resolution={FILE_RESOLUTION}
      renderer={{ kind: 'text' }}
      text={'const idea = "keep";'}
      downloadUrl="blob:test"
      {...props}
    />,
  );
}

function sourceThread(threadId: string, lineNumber: number, path = 'idea.md'): CommentThread {
  return {
    threadId,
    workspaceId: 'workspace_1',
    artifactId: FILE_RESOLUTION.artifact.artifactId,
    shareId: FILE_RESOLUTION.shareId,
    revisionId: FILE_RESOLUTION.revision.revisionId,
    visibility: 'shared',
    anchor: {
      revisionId: FILE_RESOLUTION.revision.revisionId,
      kind: 'range',
      path,
      startLine: lineNumber,
      endLine: lineNumber,
    },
    anchorStatus: 'exact',
    resolvedAt: null,
    createdAt: '2026-08-18T12:00:00.000Z',
    updatedAt: '2026-08-18T12:00:00.000Z',
    permissions: { canReply: true, canResolve: true, canReopen: false },
    posts: [
      {
        postId: `post_${threadId}`,
        threadId,
        body: `Comment in ${threadId}`,
        author: { kind: 'visitor', participantId: `person_${threadId}`, displayName: 'Reviewer' },
        permissions: { canEdit: true, canDelete: true, canModerate: false },
        createdAt: '2026-08-18T12:00:00.000Z',
        editedAt: null,
        deletedAt: null,
        hiddenAt: null,
      },
    ],
  };
}

describe('viewer content states', () => {
  it('keeps authorized history visible when new writes are off', () => {
    expect(reviewSurfaceVisible('off', 0)).toBe(false);
    expect(reviewSurfaceVisible('off', 2)).toBe(true);
    expect(reviewSurfaceVisible('private', 0)).toBe(true);
  });

  it('exposes the discussion filter labels used by the toolbar', () => {
    expect(REVIEW_THREAD_FILTERS.map((filter) => filter.label)).toEqual([
      'All discussions',
      'Unresolved',
      'Resolved',
    ]);
  });

  it('clamps the shared viewer sidebar width and falls back for malformed storage', () => {
    const bounds = viewerSidebarBounds(1440);
    const storage = reviewTestStorage();
    expect(clampViewerSidebarWidth(240, bounds)).toBe(280);
    expect(clampViewerSidebarWidth(600, bounds)).toBe(420);
    expect(readViewerSidebarWidth(storage, bounds)).toBe(320);
    storage.setItem(VIEWER_SIDEBAR_WIDTH_STORAGE_KEY, 'not-a-width');
    expect(readViewerSidebarWidth(storage, bounds)).toBe(320);
    storage.setItem(VIEWER_SIDEBAR_WIDTH_STORAGE_KEY, '401.8');
    expect(readViewerSidebarWidth(storage, bounds)).toBe(402);
    expect(
      readViewerSidebarWidth(
        {
          getItem: () => {
            throw new Error('storage unavailable');
          },
        },
        bounds,
      ),
    ).toBe(320);
  });

  it('uses the responsive tablet viewer sidebar bounds', () => {
    expect(viewerSidebarBounds(641)).toEqual({ min: 260, default: 300, max: 360 });
    expect(viewerSidebarBounds(1023)).toEqual({ min: 260, default: 300, max: 360 });
    expect(viewerSidebarBounds(1024)).toEqual({ min: 280, default: 320, max: 420 });
  });

  it('keeps the public viewer split and separator as direct library children', () => {
    const html = renderToStaticMarkup(
      <ViewerSidebarSplit
        content={<main>Preview</main>}
        sidebarOpen
        sidebar={<aside>Sidebar</aside>}
      />,
    );
    expect(html).toContain('data-group="true"');
    expect(html).toContain('data-testid="viewer-sidebar"');
    expect(html).toContain('data-testid="viewer-sidebar-resize"');
    expect(html).toContain('data-testid="viewer-content"');
  });

  it('resolves public sidebar defaults and explicit state per share revision', () => {
    const storage = reviewTestStorage();
    vi.stubGlobal('window', { localStorage: storage });
    const folderResolution = {
      ...FOLDER_RESOLUTION,
      shareId: `shr_${'f'.repeat(22)}`,
      revision: { ...FOLDER_RESOLUTION.revision, revisionId: `rev_${'g'.repeat(22)}` },
    };
    expect(readViewerSidebarOpen(FILE_RESOLUTION)).toBe(false);
    expect(readViewerSidebarOpen(folderResolution)).toBe(true);

    storage.setItem(reviewPanelStorageKey(FILE_RESOLUTION), 'malformed');
    storage.setItem(reviewPanelStorageKey(folderResolution), 'malformed');
    expect(readViewerSidebarOpen(FILE_RESOLUTION)).toBe(false);
    expect(readViewerSidebarOpen(folderResolution)).toBe(true);

    storage.setItem(reviewPanelStorageKey(FILE_RESOLUTION), 'open');
    storage.setItem(reviewPanelStorageKey(folderResolution), 'closed');
    expect(readViewerSidebarOpen(FILE_RESOLUTION)).toBe(true);
    expect(readViewerSidebarOpen(folderResolution)).toBe(false);

    const otherRevision = {
      ...FILE_RESOLUTION,
      shareId: `shr_${'d'.repeat(22)}`,
      revision: { ...FILE_RESOLUTION.revision, revisionId: `rev_${'e'.repeat(22)}` },
    };
    expect(readViewerSidebarOpen(otherRevision)).toBe(false);
  });

  it('keeps sidebar toolbar controls ordered and owned by its content region', () => {
    const html = renderToStaticMarkup(
      <ReviewSidebarToolbar
        onSearchToggle={() => undefined}
        searchOpen={false}
        threadFilter="all"
        onThreadFilterChange={() => undefined}
      />,
    );
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(labels.slice(-2)).toEqual(['Search discussions', 'Filter discussions']);
    expect(html).not.toContain('Collapse file discussions sidebar');
  });

  it('puts the collapsed public discussion reopen action in the file header', () => {
    const html = renderToStaticMarkup(
      <FileView
        fileName="idea.md"
        header={
          <>
            <strong>idea.md</strong>
            <span>42 B</span>
          </>
        }
        onOpenSidebar={() => undefined}
        sidebarControlsId="public-file-sidebar"
        sidebarLabel="file discussions sidebar"
        sidebarOpen={false}
        preview={<p>Preview</p>}
      />,
    );
    expect(html).toContain('Open file discussions sidebar');
    expect(html).toContain('aria-controls="public-file-sidebar"');
    expect(html).toContain('aria-expanded="false"');
    const openHtml = renderToStaticMarkup(
      <FileView
        fileName="idea.md"
        header={
          <>
            <strong>idea.md</strong>
            <span>42 B</span>
          </>
        }
        onOpenSidebar={() => undefined}
        sidebarControlsId="public-file-sidebar"
        sidebarLabel="file discussions sidebar"
        sidebarOpen
        preview={<p>Preview</p>}
      />,
    );
    expect(openHtml).toContain('Collapse file discussions sidebar');
    expect(openHtml).toContain('aria-expanded="true"');
  });

  it('groups multiple source discussions into one annotation per line', () => {
    const groups = groupSourceThreadsByLine(
      [sourceThread('one', 4), sourceThread('two', 4), sourceThread('elsewhere', 4, 'other.md')],
      'idea.md',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lineNumber).toBe(4);
    expect(groups[0]?.threads.map((thread) => thread.threadId)).toEqual(['one', 'two']);
  });

  it('omits source annotations when a thread has no visible posts', () => {
    const hiddenThread = { ...sourceThread('hidden', 4), posts: [] };
    expect(groupSourceThreadsByLine([hiddenThread], 'idea.md')).toEqual([]);
    const mixedGroups = groupSourceThreadsByLine(
      [hiddenThread, sourceThread('visible', 4)],
      'idea.md',
    );
    expect(mixedGroups[0]?.threads.map((thread) => thread.threadId)).toEqual(['visible']);
  });

  it('renders anchored line navigation separately from the discussion message', () => {
    const html = renderToStaticMarkup(
      <DiscussionPanel
        onCreateThread={async () => undefined}
        onNavigateToThread={() => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[
          sourceThread('line-navigation', 4),
          {
            ...sourceThread('file-navigation', 7),
            anchor: { revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' },
          },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Go to Line 4"');
    expect(html).toContain('class="review-thread-select"');
    expect(html).not.toContain('Go to Line 7');
  });

  it('keeps one line navigation control on an expanded thread with replies', () => {
    const thread = sourceThread('expanded-line-navigation', 8);
    const root = thread.posts[0];
    if (root === undefined) throw new Error('fixture post is required');
    const html = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={thread.threadId}
        onCreateThread={async () => undefined}
        onNavigateToThread={() => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[
          {
            ...thread,
            posts: [root, { ...root, postId: 'reply_expanded_line_navigation' }],
          },
        ]}
      />,
    );
    expect(html.match(/aria-label="Go to Line 8"/gu)).toHaveLength(1);
  });

  it('releases a consumed folder line request for manual selection and accepts the next one', () => {
    expect(shouldApplyFolderFocusRequest(1, undefined)).toBe(true);
    expect(shouldApplyFolderFocusRequest(1, 1)).toBe(false);
    expect(shouldApplyFolderFocusRequest(2, 1)).toBe(true);
  });

  it('distinguishes programmatic Line X selection from manual file selection', () => {
    expect(isProgrammaticFolderSelection('src/anchored.ts', 'src/anchored.ts')).toBe(true);
    expect(isProgrammaticFolderSelection('src/other.ts', 'src/anchored.ts')).toBe(false);
    expect(isProgrammaticFolderSelection('src/anchored.ts', undefined)).toBe(false);
  });

  it('uses compact relative review times and illustrated DiceBear avatars', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    expect(formatRelativeReviewTime('2026-08-20T11:00:00.000Z', now)).toBe('1h ago');
    expect(formatRelativeReviewTime('2026-08-18T12:00:00.000Z', now)).toBe('2d ago');
    expect(reviewAvatarUrl('opaque-reviewer')).toContain('/10.x/voxel-art/svg');
    expect(reviewAvatarUrl('opaque-reviewer')).toContain('tags=animation');
    expect(reviewAvatarUrl('opaque-reviewer')).toContain('seed=opaque-reviewer');
    expect(reviewAvatarUrl('opaque-reviewer')).not.toContain('/initials/svg');
  });

  it('lazy-loads non-composer review avatars without changing their explicit size', () => {
    const post = sourceThread('avatar', 1).posts[0];
    if (post === undefined) throw new Error('avatar fixture post is required');
    const html = renderToStaticMarkup(<ReviewAvatar post={post} />);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('width="28"');
    expect(html).toContain('height="28"');
  });

  it('reuses the edit composer shell for compact inline comments', () => {
    const post = sourceThread('inline-edit', 1).posts[0];
    if (post === undefined) throw new Error('inline edit fixture post is required');
    const html = renderToStaticMarkup(
      <ReviewEditComposer
        compact
        initialBody={post.body}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
        post={post}
        wrapperClassName="pierre-inline-edit-composer"
      />,
    );
    expect(html).toContain('pierre-inline-edit-composer');
    expect(html).toContain('pierre-inline-edit-actions');
    expect(html).toContain('title="Cancel edit (Esc)"');
    expect(html).toContain('title="Save edit (⌘↵)"');
    expect(html).not.toContain('review-composer-docked');
    expect(html).not.toContain('review-composer-avatar');
  });

  it('places source inline comment actions in the message heading', () => {
    const post = sourceThread('inline-actions', 1).posts[0];
    if (post === undefined) throw new Error('inline actions fixture post is required');
    const html = renderToStaticMarkup(
      <InlineSourceThread
        data={{
          expanded: true,
          label: '1 comment',
          participantPosts: [post],
          posts: [post],
        }}
        lineNumber={1}
        onDeletePost={async () => undefined}
        onEditPost={async () => undefined}
      />,
    );
    expect(html.indexOf('pierre-inline-message-actions')).toBeLessThan(
      html.indexOf('class="review-body"'),
    );
  });

  it('re-enables annotations when Show comments is activated from an annotations-off state', () => {
    const hiddenSettings = { annotations: false, comments: true };
    expect(sourceCommentsVisible(hiddenSettings)).toBe(false);

    const shownSettings = toggleSourceComments({
      ...DEFAULT_SOURCE_VIEW_SETTINGS,
      ...hiddenSettings,
    });
    expect(shownSettings.annotations).toBe(true);
    expect(shownSettings.comments).toBe(true);
    expect(sourceCommentsVisible(shownSettings)).toBe(true);
  });

  it('disables source line selection while comments are hidden', () => {
    expect(sourceLineSelectionEnabled({ ...DEFAULT_SOURCE_VIEW_SETTINGS, comments: false })).toBe(
      false,
    );
    expect(sourceLineSelectionEnabled(DEFAULT_SOURCE_VIEW_SETTINGS)).toBe(true);
  });

  it('removes a deleted root thread but keeps reply tombstones in the thread', () => {
    const thread = sourceThread('thread_transition', 7);
    const root = thread.posts[0];
    if (root === undefined) throw new Error('fixture root post is required');
    const deletedRoot = { ...root, deletedAt: '2026-08-20T12:00:00.000Z' };
    const rootTransition = applyCommentPostTransition([thread], deletedRoot);
    expect(rootTransition.threads).toEqual([]);
    expect(rootTransition.removedThreadId).toBe(thread.threadId);

    const reply = { ...root, postId: 'reply_transition', threadId: thread.threadId };
    const replyTransition = applyCommentPostTransition([{ ...thread, posts: [root, reply] }], {
      ...reply,
      deletedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(replyTransition.removedThreadId).toBeUndefined();
    expect(replyTransition.threads[0]?.posts[1]?.deletedAt).toBe('2026-08-20T12:00:00.000Z');
  });

  it('renders safe comment bodies and review controls without raw HTML', () => {
    const html = renderToStaticMarkup(
      <DiscussionPanel
        newAnchor={{ revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' }}
        onCreateThread={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[
          {
            threadId: 'thread_1',
            workspaceId: 'workspace_1',
            artifactId: FILE_RESOLUTION.artifact.artifactId,
            shareId: FILE_RESOLUTION.shareId,
            revisionId: FILE_RESOLUTION.revision.revisionId,
            visibility: 'shared',
            anchor: { revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' },
            anchorStatus: 'outdated',
            resolvedAt: null,
            createdAt: '2026-08-18T12:00:00.000Z',
            updatedAt: '2026-08-18T12:00:00.000Z',
            permissions: { canReply: true, canResolve: true, canReopen: false },
            posts: [
              {
                postId: 'post_1',
                threadId: 'thread_1',
                body: '<script>bad</script> **bold**',
                author: { kind: 'visitor', participantId: 'opaque_1', displayName: 'Reviewer' },
                permissions: { canEdit: true, canDelete: true, canModerate: false },
                createdAt: '2026-08-18T12:00:00.000Z',
                editedAt: null,
                deletedAt: null,
                hiddenAt: null,
              },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain('Outdated');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('Start a discussion');
    expect(html).toContain('Filter discussions');
    expect(html).toContain('review-composer-avatar');
    expect(html).toContain('review-composer-submit');
    expect(html).toContain('Submit comment');
  });

  it('does not offer anonymous visitors a reopen action for resolved threads', () => {
    const thread = {
      threadId: 'thread_resolved',
      workspaceId: 'workspace_1',
      artifactId: FILE_RESOLUTION.artifact.artifactId,
      shareId: FILE_RESOLUTION.shareId,
      revisionId: FILE_RESOLUTION.revision.revisionId,
      visibility: 'shared',
      anchor: { revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' },
      anchorStatus: 'exact',
      resolvedAt: '2026-08-18T12:01:00.000Z',
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:01:00.000Z',
      permissions: { canReply: false, canResolve: false, canReopen: false },
      posts: [
        {
          postId: 'post_resolved',
          threadId: 'thread_resolved',
          body: 'Done.',
          author: { kind: 'visitor', participantId: 'opaque_2', displayName: 'Reviewer' },
          permissions: { canEdit: false, canDelete: false, canModerate: false },
          createdAt: '2026-08-18T12:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: null,
        },
      ],
    } satisfies CommentThread;
    const html = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={thread.threadId}
        onCreateThread={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[thread]}
      />,
    );
    expect(html).not.toContain('review-thread-status');
    expect(html).not.toContain('Reopen thread');
  });

  it('shows an unresolve action and keeps delete while hiding edit for resolved posts', () => {
    const thread = {
      ...sourceThread('thread_moderator_resolved', 3),
      resolvedAt: '2026-08-18T12:01:00.000Z',
      permissions: { canReply: false, canResolve: false, canReopen: true },
    } satisfies CommentThread;
    const html = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={thread.threadId}
        moderator
        onCreateThread={async () => undefined}
        onDeletePost={async () => undefined}
        onEditPost={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[thread]}
      />,
    );
    expect(html).toContain('Unresolve discussion');
    expect(html).toContain('Comment actions');
    expect(html).not.toContain('Edit comment');
  });

  it('groups discussions by file and places resolved threads after unresolved ones', () => {
    const resolved = {
      ...sourceThread('thread_resolved_list', 4),
      resolvedAt: '2026-08-18T12:01:00.000Z',
    } satisfies CommentThread;
    const html = renderToStaticMarkup(
      <DiscussionPanel
        onCreateThread={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[
          resolved,
          sourceThread('thread_open_list', 5),
          sourceThread('thread_other_list', 6, 'other.md'),
        ]}
      />,
    );
    expect(html.indexOf('Comment in thread_open_list')).toBeLessThan(
      html.indexOf('Comment in thread_resolved_list'),
    );
    expect(html.match(/class="review-discussion-file-heading"/gu)).toHaveLength(2);
    expect(html.match(/aria-expanded="true"/gu)).toHaveLength(2);
    expect(html).toContain('aria-controls="review-discussion-group-idea.md"');
    expect(html).toContain('review-discussion-status-divider');
    expect(html).not.toContain('Resolved (1)');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('review-thread-status');
    expect(html).toContain('review-resolved-indicator');
  });

  it('uses the reply composer shell for editing a discussion post', () => {
    const thread = sourceThread('thread_edit_composer', 2);
    const post = thread.posts[0];
    if (post === undefined) throw new Error('fixture post is required');
    const html = renderToStaticMarkup(
      <ReviewEditComposer
        initialBody={post.body}
        onCancel={() => undefined}
        onSubmit={async () => undefined}
        post={post}
        showAvatar={false}
      />,
    );
    expect(html).toContain('review-composer-edit');
    expect(html).toContain('review-composer-input');
    expect(html).toContain('review-composer-submit');
    expect(html).not.toContain('review-composer-avatar');
    expect(html).not.toContain('review-message-editor');
  });

  it('shows comment actions only when the projected post permissions allow them', () => {
    const editableThread = sourceThread('thread_editable', 2);
    const moderatorHtml = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={editableThread.threadId}
        moderator
        onCreateThread={async () => undefined}
        onDeletePost={async () => undefined}
        onEditPost={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[editableThread]}
      />,
    );
    expect(moderatorHtml).toContain('Comment actions');

    const noHandlersHtml = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={editableThread.threadId}
        moderator
        onCreateThread={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[editableThread]}
      />,
    );
    expect(noHandlersHtml).not.toContain('Comment actions');

    const readOnlyThread = {
      ...editableThread,
      posts: editableThread.posts.map((post) => ({
        ...post,
        permissions: { canEdit: false, canDelete: false, canModerate: false },
      })),
    };
    const visitorHtml = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={readOnlyThread.threadId}
        onCreateThread={async () => undefined}
        onDeletePost={async () => undefined}
        onEditPost={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[readOnlyThread]}
      />,
    );
    expect(visitorHtml).not.toContain('Comment actions');
  });

  it('distinguishes an unresolved thread that cannot accept replies', () => {
    const thread = {
      threadId: 'thread_locked',
      workspaceId: 'workspace_1',
      artifactId: FILE_RESOLUTION.artifact.artifactId,
      shareId: FILE_RESOLUTION.shareId,
      revisionId: FILE_RESOLUTION.revision.revisionId,
      visibility: 'private',
      anchor: { revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' },
      anchorStatus: 'exact',
      resolvedAt: null,
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:00.000Z',
      permissions: { canReply: false, canResolve: true, canReopen: false },
      posts: [],
    } satisfies CommentThread;
    const html = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={thread.threadId}
        onCreateThread={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[thread]}
      />,
    );
    expect(html).toContain('Replies are disabled for this link.');
    expect(html).toContain('Resolve thread');
    expect(html).not.toContain('Resolved</p>');
  });

  it('shows hidden visitor post bodies and unhide controls to moderators', () => {
    const thread = {
      threadId: 'thread_hidden',
      workspaceId: 'workspace_1',
      artifactId: FILE_RESOLUTION.artifact.artifactId,
      shareId: FILE_RESOLUTION.shareId,
      revisionId: FILE_RESOLUTION.revision.revisionId,
      visibility: 'shared',
      anchor: { revisionId: FILE_RESOLUTION.revision.revisionId, kind: 'file' },
      anchorStatus: 'exact',
      resolvedAt: null,
      createdAt: '2026-08-18T12:00:00.000Z',
      updatedAt: '2026-08-18T12:00:00.000Z',
      permissions: { canReply: true, canResolve: true, canReopen: false },
      posts: [
        {
          postId: 'post_hidden',
          threadId: 'thread_hidden',
          body: 'Visitor body retained for moderation.',
          author: { kind: 'visitor', participantId: 'visitor_1', displayName: 'Visitor' },
          permissions: { canEdit: false, canDelete: false, canModerate: true },
          createdAt: '2026-08-18T12:00:00.000Z',
          editedAt: null,
          deletedAt: null,
          hiddenAt: '2026-08-18T12:01:00.000Z',
        },
      ],
    } satisfies CommentThread;
    const html = renderToStaticMarkup(
      <DiscussionPanel
        activeThreadId={thread.threadId}
        moderator
        onCreateThread={async () => undefined}
        onModeratePost={async () => undefined}
        onReply={async () => undefined}
        onSelectThread={() => undefined}
        onSetThreadStatus={async () => undefined}
        threads={[thread]}
      />,
    );
    expect(html).toContain('Hidden');
    expect(html).toContain('Visitor body retained for moderation.');
    expect(html).toContain('Comment actions');
    expect(html).not.toContain('review-post-controls');
    expect(html).not.toContain('review-post-action');
  });
  it('renders source through the syntax-aware viewer and formatted JSON', () => {
    const text = renderContent({ text: '<script>unsafe</script>' });
    expect(text).toContain('Loading file…');
    expect(text).not.toContain('<script>unsafe</script>');
    expect(text.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(renderContent({ renderer: { kind: 'json' }, text: '{"name":"shelf"}' })).toContain(
      'Loading file…',
    );
  });

  it('offers Preview and Source for readable rendered files', () => {
    const markdown = renderContent({
      renderer: { kind: 'markdown' },
      text: '# A readable artifact',
    });
    expect(markdown).toContain('Preview');
    expect(markdown).toContain('Source');
    expect(markdown).toContain('A readable artifact');

    const raster = renderContent({ renderer: { kind: 'image' }, text: undefined });
    expect(raster).not.toContain('Source');
  });

  it('keeps file size and view controls in the same rendered header', () => {
    const html = renderToStaticMarkup(
      <FileView
        header={
          <>
            <strong>notes/idea.md</strong>
            <span>42 B</span>
          </>
        }
        onOpenSidebar={() => undefined}
        preview={<p>Rendered preview</p>}
        sidebarControlsId="artifact-discussion-sidebar"
        sidebarLabel="discussions sidebar"
        sidebarOpen
        source="# Raw source"
      />,
    );
    expect(html.indexOf('42 B')).toBeLessThan(html.indexOf('Preview'));
    expect(html.indexOf('file-view-sidebar-toggle')).toBeLessThan(html.indexOf('Preview'));
    expect(html).toContain('Collapse discussions sidebar');
    expect(html).toContain('aria-controls="artifact-discussion-sidebar"');
    expect(html).toContain('Source');
  });

  it('renders source-only files when the rendered header is present', () => {
    const html = renderToStaticMarkup(
      <FileView header={<span>35 B</span>} source="export const shelfFolderQa = true;" />,
    );
    expect(html).toContain('Loading file…');
  });

  it('keeps preview-only loading content visible beneath its rendered header', () => {
    const html = renderToStaticMarkup(
      <FileView header={<span>35 B</span>} preview={<FileLoadingState />} />,
    );
    expect(html).toContain('Loading file…');
    expect(html).toContain('file-loading-skeleton');
  });

  it('exposes practical source controls without comment affordances outside review', () => {
    const html = renderToStaticMarkup(
      <SourceView fileName="example.ts" source="const shelf = true;" />,
    );
    expect(html).not.toContain('Find in source');
    expect(html).toContain('Wrap');
    expect(html).toContain('aria-label="Disable word wrap"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Lines');
    expect(html).not.toContain('Comments');
    expect(html).not.toContain('aria-label="Hide comments"');
    expect(html).toContain('Copy');
    expect(html).toContain('Source view settings');
  });

  it('offers the comments toggle when a review context is present', () => {
    const html = renderToStaticMarkup(
      <SourceView
        fileName="example.ts"
        review={{
          canCreateThread: false,
          onCreateThread: () => Promise.resolve(),
          onSelectThread: () => undefined,
          revisionId: 'rev_example',
          threads: [],
        }}
        source="const shelf = true;"
      />,
    );
    expect(html).toContain('Comments');
    expect(html).toContain('aria-label="Hide comments"');
  });

  it('hides descendants when a folder is collapsed', () => {
    const collapsed = new Set(['src']);
    expect(isFolderEntryVisible('src/example.ts', collapsed)).toBe(false);
    expect(isFolderEntryVisible('src/nested/example.ts', collapsed)).toBe(false);
    expect(isFolderEntryVisible('README.md', collapsed)).toBe(true);
    expect(isFolderEntryVisible('src', collapsed)).toBe(true);
  });

  it('remounts a folder file view after its persisted file finishes loading', () => {
    expect(folderFileViewKey('src/example.ts', true)).not.toBe(
      folderFileViewKey('src/example.ts', false),
    );
  });

  it('renders an allowlisted raster image without embedding active markup', () => {
    const html = renderContent({ renderer: { kind: 'image' } });
    expect(html).toContain('<img');
    expect(html).toContain('src="blob:test"');
  });

  it('renders folder entries as a browsable tree', () => {
    const entries: FolderEntry[] = [
      { kind: 'directory', path: 'notes' },
      {
        kind: 'file',
        path: 'notes/idea.md',
        mediaType: 'text/markdown',
        contentHash: `sha256:${'d'.repeat(64)}`,
        byteCount: 42,
      },
    ];
    const html = renderContent({ entries, resolution: FOLDER_RESOLUTION });
    expect(html).toContain('notes');
    expect(html).toContain('idea.md');
    expect(html).toContain('<svg');
    expect(html).not.toContain('tree-icon');
  });

  it('uses Pierre Trees for the interactive folder navigator', () => {
    const html = renderToStaticMarkup(
      <FolderBrowser
        entries={[
          { kind: 'directory', path: 'src' },
          { kind: 'directory', path: 'empty' },
          {
            kind: 'file',
            path: 'src/example.ts',
            mediaType: 'text/typescript',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 21,
          },
        ]}
        loadFile={async () => new TextEncoder().encode('const shelf = true;').buffer}
      />,
    );
    expect(html).toContain('folder-browser-pierre-tree');
    expect(html).toContain('aria-label="Folder contents"');
  });

  it('keeps preview folder navigation read-only with a searchable Files sidebar', () => {
    const html = renderToStaticMarkup(
      <FolderBrowser
        entries={[
          {
            kind: 'file',
            path: 'src/example.ts',
            mediaType: 'text/typescript',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 21,
          },
        ]}
        loadFile={async () => new TextEncoder().encode('const shelf = true;').buffer}
        navigation={{
          onSidebarToggle: () => undefined,
          sidebarControlsId: 'preview-folder-sidebar-content',
          sidebarOpen: true,
        }}
      />,
    );
    expect(html).toContain('Files');
    expect(html).toContain('Search files');
    expect(html).toContain('Collapse folder files sidebar');
    expect(html).toContain('aria-controls="preview-folder-sidebar-content"');
    expect(html).not.toContain('Discussion');
    expect(html).not.toContain('Filter discussions');
    expect(html).not.toContain('New comment');
    expect(html).not.toContain('Leave a comment');
  });

  it('owns discussion filters at the folder-browser toolbar boundary', () => {
    const review = {
      canCreateThread: true,
      mode: 'discussion' as const,
      revisionId: FOLDER_RESOLUTION.revision.revisionId,
      threads: [sourceThread('folder_discussion', 1, 'src/example.ts')],
      onCreateThread: async () => undefined,
      onModeChange: () => undefined,
      onReply: async () => undefined,
      onSelectThread: () => undefined,
      onSetThreadStatus: async () => undefined,
    };
    const discussionHtml = renderToStaticMarkup(
      <FolderBrowser
        entries={[
          {
            kind: 'file',
            path: 'src/example.ts',
            mediaType: 'text/typescript',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 21,
          },
        ]}
        loadFile={async () => new TextEncoder().encode('const shelf = true;').buffer}
        review={review}
      />,
    );
    expect(discussionHtml).toContain('aria-label="Filter discussions"');

    const filesHtml = renderToStaticMarkup(
      <FolderBrowser
        entries={[
          {
            kind: 'file',
            path: 'src/example.ts',
            mediaType: 'text/typescript',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 21,
          },
        ]}
        loadFile={async () => new TextEncoder().encode('const shelf = true;').buffer}
        review={{ ...review, mode: 'tree' }}
      />,
    );
    expect(filesHtml).not.toContain('aria-label="Filter discussions"');

    const collapsedFolderHtml = renderToStaticMarkup(
      <FolderBrowser
        entries={[
          {
            kind: 'file',
            path: 'src/example.ts',
            mediaType: 'text/typescript',
            contentHash: `sha256:${'d'.repeat(64)}`,
            byteCount: 21,
          },
        ]}
        loadFile={async () => new TextEncoder().encode('const shelf = true;').buffer}
        review={{
          ...review,
          onSidebarToggle: () => undefined,
          sidebarControlsId: 'managed-folder-sidebar-content',
          sidebarOpen: false,
        }}
      />,
    );
    expect(collapsedFolderHtml).toContain('Open folder tree and discussions sidebar');
    expect(collapsedFolderHtml).toContain('aria-controls="managed-folder-sidebar-content"');
    expect(collapsedFolderHtml).toContain('aria-expanded="false"');
  });

  it('gives download-only files a clear quiet state', () => {
    const html = renderContent({ renderer: { kind: 'download' }, text: undefined });
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('Download idea.md');
  });

  it('uses the same unavailable projection for every failed public lookup', () => {
    const html = renderToStaticMarkup(<UnavailableView />);
    expect(html).toContain('This artifact is unavailable');
    expect(html).not.toMatch(/revoked|expired|secret|permission/i);
  });

  it('presents a compact artifact map without decorative trust indicators', () => {
    const html = renderToStaticMarkup(
      <ViewerRail
        authority={{ accessType: 'public', publicCode: 'pub_1234567890' }}
        resolution={FILE_RESOLUTION}
      />,
    );

    expect(html).toContain('Shared artifact');
    expect(html).toContain('idea.md');
    expect(html).toContain('Latest');
    expect(html).toContain('Download');
    expect(html).toContain('rail-secondary-separator');
    expect(html).not.toContain('trust-dot');

    const pinnedHtml = renderToStaticMarkup(
      <ViewerRail
        authority={{ accessType: 'public', publicCode: 'pub_1234567890' }}
        resolution={FOLDER_RESOLUTION}
      />,
    );
    expect(pinnedHtml).toContain('Pinned');
  });
});
