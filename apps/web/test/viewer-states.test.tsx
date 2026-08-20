import type { CommentThread, FolderEntry, PublicShareResolution } from '@shelf/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactContent } from '../src/components/artifact-content.js';
import {
  FileLoadingState,
  FileView,
  groupSourceThreadsByLine,
  SourceView,
} from '../src/components/file-view.js';
import { FolderBrowser, isFolderEntryVisible } from '../src/components/folder-browser.js';
import {
  formatRelativeReviewTime,
  reviewAvatarUrl,
} from '../src/components/review/comment-card.js';
import { DiscussionPanel } from '../src/components/review/discussion-panel.js';
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
    expect(reviewAvatarUrl('opaque-reviewer')).toContain('/notionists-neutral/svg');
    expect(reviewAvatarUrl('opaque-reviewer')).toContain('backgroundColor=e4e4e7');
    expect(reviewAvatarUrl('opaque-reviewer')).not.toContain('/initials/svg');
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
    expect(html).toContain('Resolved');
    expect(html).not.toContain('Reopen thread');
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
    expect(html).toContain('Lines');
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
