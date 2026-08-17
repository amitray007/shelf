import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  ArtifactPageSchema,
  ArtifactRevisionPageSchema,
  ArtifactSchema,
  isArtifact,
  isArtifactPage,
  isArtifactRevisionPage,
} from '../src/index.js';

const revision = {
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  revisionNumber: 2,
  originalFileName: 'CHANGELOG.md',
  mediaType: 'text/markdown',
  contentHash: `sha256:${'b'.repeat(64)}`,
  byteCount: 24,
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
});
