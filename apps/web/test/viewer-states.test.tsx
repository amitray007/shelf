import type { CommentThread, FolderEntry, PublicShareResolution } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactContent } from '../src/components/artifact-content.js';
import {
  DEFAULT_SOURCE_VIEW_SETTINGS,
  FileLoadingState,
  FileView,
  groupSourceThreadsByLine,
  SourceView,
  sourceCommentsVisible,
  toggleSourceComments,
} from '../src/components/file-view.js';
import { FolderBrowser, isFolderEntryVisible } from '../src/components/folder-browser.js';
import {
  formatRelativeReviewTime,
  ReviewAvatar,
  reviewAvatarUrl,
} from '../src/components/review/comment-card.js';
import { DiscussionPanel, ReviewEditComposer } from '../src/components/review/discussion-panel.js';
import { applyCommentPostTransition } from '../src/components/review/thread-state.js';
import { REVIEW_THREAD_FILTERS } from '../src/components/review/types.js';
import { reviewSurfaceVisible } from '../src/components/review/use-review.js';
import { UnavailableView, ViewerRail } from '../src/components/viewer-shell.js';

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

  it('groups multiple source discussions into one annotation per line', () => {
    const groups = groupSourceThreadsByLine(
      [sourceThread('one', 4), sourceThread('two', 4), sourceThread('elsewhere', 4, 'other.md')],
      'idea.md',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lineNumber).toBe(4);
    expect(groups[0]?.threads.map((thread) => thread.threadId)).toEqual(['one', 'two']);
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
        threads={[resolved, sourceThread('thread_open_list', 5)]}
      />,
    );
    expect(html.indexOf('Comment in thread_open_list')).toBeLessThan(
      html.indexOf('Comment in thread_resolved_list'),
    );
    expect(html.match(/class="review-discussion-file-heading"/gu)).toHaveLength(1);
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
      />,
    );
    expect(html).toContain('review-composer-edit');
    expect(html).toContain('review-composer-input');
    expect(html).toContain('review-composer-submit');
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
    expect(html).toContain('Unhide visitor post');
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
        preview={<p>Rendered preview</p>}
        source="# Raw source"
      />,
    );
    expect(html.indexOf('42 B')).toBeLessThan(html.indexOf('Preview'));
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

  it('exposes practical source controls', () => {
    const html = renderToStaticMarkup(
      <SourceView fileName="example.ts" source="const shelf = true;" />,
    );
    expect(html).not.toContain('Find in source');
    expect(html).toContain('Wrap');
    expect(html).toContain('aria-label="Disable word wrap"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Lines');
    expect(html).toContain('Comments');
    expect(html).toContain('aria-label="Hide comments"');
    expect(html).toContain('Copy');
    expect(html).toContain('Source view settings');
  });

  it('hides descendants when a folder is collapsed', () => {
    const collapsed = new Set(['src']);
    expect(isFolderEntryVisible('src/example.ts', collapsed)).toBe(false);
    expect(isFolderEntryVisible('src/nested/example.ts', collapsed)).toBe(false);
    expect(isFolderEntryVisible('README.md', collapsed)).toBe(true);
    expect(isFolderEntryVisible('src', collapsed)).toBe(true);
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
