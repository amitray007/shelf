import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  FolderPublishResultSchema,
  FolderTreePageSchema,
  isFolderPublishResult,
  isFolderTreePage,
} from '../src/index.js';

describe('folder snapshot contracts', () => {
  it('accepts one canonical folder publish result and bounded tree page', () => {
    const revisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';
    const artifactId = 'art_AAAAAAAAAAAAAAAAAAAAAA';
    const contentHash = `sha256:${'a'.repeat(64)}`;
    const published = {
      apiVersion: 'v1',
      kind: 'folder',
      workspaceId: 'workspace-main',
      artifactId,
      revisionId,
      contentHash,
      byteCount: 12,
      fileCount: 2,
      provenance: {
        classification: 'direct-publish',
        observed: { actorId: 'actor-agent', operation: 'file.publish' },
      },
      publisherMetadata: { source: 'test' },
      requestId: 'request-folder',
      paths: {
        artifact: `/api/v1/artifacts/${artifactId}`,
        revision: `/api/v1/revisions/${revisionId}`,
        tree: `/api/v1/revisions/${revisionId}/tree`,
      },
      replayed: false,
    };
    const tree = {
      apiVersion: 'v1',
      revisionId,
      contentHash,
      byteCount: 12,
      fileCount: 2,
      items: [
        { path: 'docs', kind: 'directory' },
        {
          path: 'docs/README.md',
          kind: 'file',
          mediaType: 'text/markdown',
          contentHash: `sha256:${'b'.repeat(64)}`,
          byteCount: 7,
        },
      ],
      nextCursor: null,
    };

    expect(Check(FolderPublishResultSchema, published)).toBe(true);
    expect(Check(FolderTreePageSchema, tree)).toBe(true);
    expect(isFolderPublishResult(published)).toBe(true);
    expect(isFolderTreePage(tree)).toBe(true);
    expect(
      isFolderTreePage({
        ...tree,
        items: [{ path: '../escape', kind: 'directory' }],
      }),
    ).toBe(false);
  });
});
