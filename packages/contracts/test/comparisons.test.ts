import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  FileRevisionComparisonSchema,
  FolderRevisionComparisonSchema,
  isRevisionComparison,
} from '../src/index.js';

const baseRevisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';
const targetRevisionId = 'rev_BBBBBBBBBBBBBBBBBBBBBB';
const artifactId = 'art_AAAAAAAAAAAAAAAAAAAAAA';

describe('revision comparison contracts', () => {
  it('accepts an exact file descriptor comparison', () => {
    const comparison = {
      apiVersion: 'v1',
      kind: 'file',
      workspaceId: 'workspace-main',
      artifactId,
      base: {
        revisionId: baseRevisionId,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 8,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      target: {
        revisionId: targetRevisionId,
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteCount: 9,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      status: 'changed',
      changes: { content: true, mediaType: false, originalFileName: false },
    };

    expect(Check(FileRevisionComparisonSchema, comparison)).toBe(true);
    expect(isRevisionComparison(comparison)).toBe(true);
  });

  it('accepts a bounded folder change page with exact move evidence', () => {
    const before = {
      path: 'old.txt',
      kind: 'file',
      mediaType: 'text/plain',
      contentHash: `sha256:${'c'.repeat(64)}`,
      byteCount: 4,
    };
    const after = { ...before, path: 'new.txt' };
    const comparison = {
      apiVersion: 'v1',
      kind: 'folder',
      workspaceId: 'workspace-main',
      artifactId,
      base: {
        revisionId: baseRevisionId,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 4,
        fileCount: 1,
        rootName: 'Project',
      },
      target: {
        revisionId: targetRevisionId,
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteCount: 4,
        fileCount: 1,
        rootName: 'Project',
      },
      summary: { added: 0, removed: 0, moved: 1, changed: 0, unchanged: 0 },
      items: [{ status: 'moved', fromPath: 'old.txt', toPath: 'new.txt', before, after }],
      nextCursor: null,
    };

    expect(Check(FolderRevisionComparisonSchema, comparison)).toBe(true);
    expect(isRevisionComparison(comparison)).toBe(true);
    expect(
      Check(FolderRevisionComparisonSchema, {
        ...comparison,
        items: [...comparison.items, ...Array.from({ length: 100 }, () => comparison.items[0])],
      }),
    ).toBe(false);
  });
});
