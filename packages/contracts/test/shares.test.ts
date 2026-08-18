import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  CLI_EXIT_CODES,
  exitCodeForError,
  isPublicShareResolution,
  isShareCreateResult,
  isSharePage,
  PublicShareResolutionSchema,
  ShareCreateResultSchema,
  ShareManagementSummarySchema,
  SharePageSchema,
} from '../src/index.js';

const shareId = 'shr_AAAAAAAAAAAAAAAAAAAAAA';
const artifactId = 'art_BBBBBBBBBBBBBBBBBBBBBB';
const revisionId = 'rev_CCCCCCCCCCCCCCCCCCCCCC';

const summary = {
  apiVersion: 'v1',
  workspaceId: 'workspace-main',
  shareId,
  artifactId,
  visibility: 'unlisted',
  target: { mode: 'pinned', revisionId, revisionNumber: 3 },
  createdAt: '2026-08-17T12:00:00.000Z',
  expiresAt: '2026-08-24T12:00:00.000Z',
  revokedAt: null,
  url: `/s/${shareId}#${'s'.repeat(43)}`,
};

describe('share contracts', () => {
  it('returns reusable capability URLs only in authorized management contracts', () => {
    const result = {
      ...summary,
      target: { mode: 'pinned', revisionId },
      requestId: 'request-create-share',
      replayed: false,
    };
    const page = {
      apiVersion: 'v1',
      workspaceId: summary.workspaceId,
      items: [summary],
      nextCursor: null,
    };

    expect(Check(ShareCreateResultSchema, result)).toBe(true);
    expect(isShareCreateResult(result)).toBe(true);
    expect(Check(ShareManagementSummarySchema, summary)).toBe(true);
    expect(Check(SharePageSchema, page)).toBe(true);
    expect(isSharePage(page)).toBe(true);
    expect(isSharePage({ ...page, items: [{ ...summary, url: undefined }] })).toBe(false);
  });

  it('accepts a sanitized public file projection with a content action', () => {
    const resolution = {
      apiVersion: 'v1',
      shareId,
      target: { mode: 'latest' },
      artifact: { artifactId, kind: 'file', name: 'Launch notes' },
      revision: {
        kind: 'file',
        revisionId,
        revisionNumber: 2,
        createdAt: '2026-08-17T12:03:00.000Z',
        originalFileName: 'launch.md',
        mediaType: 'text/markdown',
        byteCount: 84,
      },
      action: {
        type: 'content',
        path: `/api/v1/public/shares/${shareId}/content`,
      },
      expiresAt: null,
    };

    expect(Check(PublicShareResolutionSchema, resolution)).toBe(true);
    expect(isPublicShareResolution(resolution)).toBe(true);
    expect(
      isPublicShareResolution({
        ...resolution,
        workspaceId: 'workspace-main',
        actorId: 'actor-publisher',
        publisherMetadata: { source: 'private' },
        contentId: 'provider-object-key',
      }),
    ).toBe(false);
  });

  it('accepts a sanitized public folder projection with a tree action', () => {
    const resolution = {
      apiVersion: 'v1',
      shareId,
      target: { mode: 'pinned', revisionId },
      artifact: { artifactId, kind: 'folder', name: 'Prototype' },
      revision: {
        kind: 'folder',
        revisionId,
        revisionNumber: 4,
        createdAt: '2026-08-17T12:04:00.000Z',
        rootName: 'prototype',
        byteCount: 1234,
        fileCount: 8,
      },
      action: {
        type: 'tree',
        path: `/api/v1/public/shares/${shareId}/tree`,
      },
      expiresAt: null,
    };

    expect(Check(PublicShareResolutionSchema, resolution)).toBe(true);
    expect(isPublicShareResolution(resolution)).toBe(true);
    expect(
      isPublicShareResolution({
        ...resolution,
        action: { ...resolution.action, providerUrl: 'https://storage.example/private' },
      }),
    ).toBe(false);
  });

  it('maps non-enumerating share misses to the stable validation exit class', () => {
    expect(exitCodeForError('SHARE_NOT_FOUND')).toBe(CLI_EXIT_CODES.validation);
  });

  it('maps an expired artifact recovery to the stable validation exit class', () => {
    expect(exitCodeForError('ARTIFACT_RECOVERY_EXPIRED')).toBe(CLI_EXIT_CODES.validation);
  });
});
