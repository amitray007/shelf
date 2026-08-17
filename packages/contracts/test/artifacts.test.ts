import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  ArtifactPageSchema,
  ArtifactRevisionPageSchema,
  ArtifactRevisionSchema,
  ArtifactSchema,
  isArtifact,
  isArtifactPage,
  isArtifactRevisionPage,
  isRestoreResult,
  RestoreResultSchema,
} from '../src/index.js';

const revision = {
  kind: 'file',
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  revisionNumber: 2,
  originalFileName: 'CHANGELOG.md',
  mediaType: 'text/markdown',
  contentHash: `sha256:${'b'.repeat(64)}`,
  byteCount: 24,
  fileCount: 1,
  createdAt: '2026-08-17T12:01:00.000Z',
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor_example', operation: 'file.publish' },
  },
  publisherMetadata: { source: 'agent' },
  paths: {
    revision: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB',
    content: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB/content',
  },
};

const artifact = {
  apiVersion: 'v1',
  workspaceId: 'workspace-main',
  artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'file',
  name: 'Release notes',
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:01:00.000Z',
  latestRevision: revision,
  paths: {
    artifact: '/api/v1/artifacts/art_AAAAAAAAAAAAAAAAAAAAAA',
    revisions: '/api/v1/artifacts/art_AAAAAAAAAAAAAAAAAAAAAA/revisions',
  },
};

describe('artifact catalog contracts', () => {
  it('accepts canonical artifact detail and bounded cursor pages', () => {
    const artifacts = { apiVersion: 'v1', items: [artifact], nextCursor: 'cursor-next' };
    const revisions = {
      apiVersion: 'v1',
      artifactId: artifact.artifactId,
      workspaceId: artifact.workspaceId,
      items: [revision],
      nextCursor: null,
    };

    expect(Check(ArtifactSchema, artifact)).toBe(true);
    expect(Check(ArtifactPageSchema, artifacts)).toBe(true);
    expect(Check(ArtifactRevisionPageSchema, revisions)).toBe(true);
    expect(isArtifact(artifact)).toBe(true);
    expect(isArtifactPage(artifacts)).toBe(true);
    expect(isArtifactRevisionPage(revisions)).toBe(true);
    expect(isArtifact({ ...artifact, installationId: 'secret-installation' })).toBe(false);
    expect(isArtifactPage({ ...artifacts, nextCursor: '' })).toBe(false);
  });

  it('accepts restore provenance that names the immutable source revision', () => {
    const restored = {
      ...revision,
      revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
      revisionNumber: 4,
      provenance: {
        classification: 'restore',
        observed: { actorId: 'actor_example', operation: 'revision.restore' },
        source: { revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA' },
      },
    };

    expect(Check(ArtifactRevisionSchema, restored)).toBe(true);
    expect(
      Check(ArtifactRevisionSchema, {
        ...restored,
        provenance: { ...restored.provenance, source: { revisionId: artifact.artifactId } },
      }),
    ).toBe(false);
  });

  it('accepts one canonical restore result for CLI replay safety', () => {
    const result = {
      apiVersion: 'v1',
      kind: 'file',
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
      revisionNumber: 4,
      sourceRevisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA',
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 18,
      fileCount: 1,
      provenance: {
        classification: 'restore',
        observed: { actorId: 'actor_example', operation: 'revision.restore' },
        source: { revisionId: 'rev_AAAAAAAAAAAAAAAAAAAAAA' },
      },
      requestId: 'request-restore',
      paths: {
        artifact: `/api/v1/artifacts/${artifact.artifactId}`,
        revision: '/api/v1/revisions/rev_CCCCCCCCCCCCCCCCCCCCCC',
        content: '/api/v1/revisions/rev_CCCCCCCCCCCCCCCCCCCCCC/content',
      },
      replayed: false,
    };

    expect(Check(RestoreResultSchema, result)).toBe(true);
    expect(isRestoreResult(result)).toBe(true);
    expect(isRestoreResult({ ...result, sourceRevisionId: artifact.artifactId })).toBe(false);
  });
});
