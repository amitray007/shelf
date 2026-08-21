import type { ArtifactRevision } from '@shelf/contracts';
import { describe, expect, it } from 'vitest';

import {
  expirySummary,
  PRIVATE_COMMENT_POLICY_DESCRIPTION,
  SHARED_COMMENT_POLICY_DESCRIPTION,
  targetSummary,
} from '../src/dashboard/share-dialog.js';

describe('custom share dialog comments policy', () => {
  it('explains Private and Shared semantics without implying cross-link sharing', () => {
    expect(PRIVATE_COMMENT_POLICY_DESCRIPTION).toBe(
      'Visitors see only discussions they started; admins can see all.',
    );
    expect(SHARED_COMMENT_POLICY_DESCRIPTION).toBe(
      'Everyone using this link can see shared discussions.',
    );
    expect(SHARED_COMMENT_POLICY_DESCRIPTION).not.toContain('across shared links');
  });
});

function revision(revisionId: string, revisionNumber: number): ArtifactRevision {
  return {
    revisionId,
    revisionNumber,
    contentHash: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-08-18T10:00:00.000Z',
    provenance: {
      classification: 'direct-publish',
      observed: { actorId: 'actor-owner', operation: 'file.publish' },
    },
    publisherMetadata: {},
    kind: 'file',
    originalFileName: 'notes.md',
    mediaType: 'text/markdown',
    byteCount: 89,
    fileCount: 1,
    paths: {
      revision: `/api/v1/revisions/${revisionId}`,
      content: `/api/v1/revisions/${revisionId}/content`,
    },
  };
}

describe('share dialog options summary', () => {
  it('summarises the never and custom expiry choices without a duration', () => {
    expect(expirySummary('never')).toBe('Never expires');
    expect(expirySummary('custom')).toBe('Custom expiry');
  });

  it.each([
    ['5m', 'Expires in 5 minutes'],
    ['30m', 'Expires in 30 minutes'],
    ['2hr', 'Expires in 2 hours'],
    ['24hr', 'Expires in 24 hours'],
    ['30d', 'Expires in 30 days'],
  ] as const)('summarises the %s expiry choice as a lowercase duration', (choice, expected) => {
    expect(expirySummary(choice)).toBe(expected);
  });

  it('summarises a latest target without consulting the revision list', () => {
    expect(targetSummary('latest', [], '')).toBe('Latest revision');
    expect(targetSummary('latest', [revision(`rev_${'a'.repeat(22)}`, 12)], 'ignored')).toBe(
      'Latest revision',
    );
  });

  it('names the pinned revision by ordinal when it is loaded', () => {
    const revisions = [revision(`rev_${'a'.repeat(22)}`, 12), revision(`rev_${'b'.repeat(22)}`, 3)];
    expect(targetSummary('pinned', revisions, `rev_${'a'.repeat(22)}`)).toBe(
      'Pinned: 12th revision',
    );
    expect(targetSummary('pinned', revisions, `rev_${'b'.repeat(22)}`)).toBe(
      'Pinned: 3rd revision',
    );
  });

  it('falls back to a generic pinned summary when the revision is not loaded', () => {
    expect(targetSummary('pinned', [], `rev_${'z'.repeat(22)}`)).toBe('Pinned revision');
    expect(
      targetSummary('pinned', [revision(`rev_${'a'.repeat(22)}`, 12)], `rev_${'z'.repeat(22)}`),
    ).toBe('Pinned revision');
  });

  it('composes the disclosure summary the share dialog renders for its defaults', () => {
    expect(
      [targetSummary('latest', [], ''), expirySummary('never'), 'Comments off'].join(' · '),
    ).toBe('Latest revision · Never expires · Comments off');
  });
});
