import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  CLI_EXIT_CODES,
  exitCodeForError,
  isProtectedSessionAuthority,
  isPublicShareResolution,
  isShareCreateInput,
  isShareCreateResult,
  isSharePage,
  ProtectedSessionAuthoritySchema,
  ProtectedSessionEstablishInputSchema,
  PublicShareResolutionSchema,
  SHARE_EXPIRY_PRESETS,
  ShareCreateInputSchema,
  ShareCreateResultSchema,
  ShareManagementSummarySchema,
  SharePageSchema,
} from '../src/index.js';

const shareId = 'shr_AAAAAAAAAAAAAAAAAAAAAA';
const artifactId = 'art_BBBBBBBBBBBBBBBBBBBBBB';
const revisionId = 'rev_CCCCCCCCCCCCCCCCCCCCCC';
const publicCode = 'AbCdEf0123_-';

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
  status: 'active',
  accessType: 'protected',
  commentPolicy: 'off',
  maxSessions: 5,
  sessionsUsed: 2,
  sessionsRemaining: 3,
  url: `/s/${shareId}#${'s'.repeat(43)}`,
};

describe('share contracts', () => {
  it('exposes the canonical expiry presets in product order', () => {
    expect(SHARE_EXPIRY_PRESETS).toEqual([
      '5m',
      '30m',
      '2hr',
      '6hr',
      '24hr',
      '3d',
      '7d',
      '15d',
      '30d',
    ]);
  });

  it('accepts every Protected policy combination with Latest or pinned targets', () => {
    const inputs = [
      { accessType: 'protected', target: { mode: 'latest' } },
      {
        accessType: 'protected',
        target: { mode: 'latest' },
        expiresIn: '7d',
      },
      {
        accessType: 'protected',
        target: { mode: 'latest' },
        maxSessions: 5,
      },
      {
        accessType: 'protected',
        target: { mode: 'pinned', revisionId },
        expiresAt: '2026-08-24T12:00:00.000Z',
        maxSessions: 5,
      },
      {
        accessType: 'protected',
        target: { mode: 'latest' },
        expiresIn: 'never',
      },
    ];

    for (const input of inputs) {
      expect(Check(ShareCreateInputSchema, input)).toBe(true);
      expect(isShareCreateInput(input)).toBe(true);
    }
  });

  it('accepts Public default, preset, and custom expiry inputs', () => {
    const inputs = [
      { accessType: 'public', target: { mode: 'latest' } },
      { accessType: 'public', target: { mode: 'latest' }, expiresIn: '24hr' },
      {
        accessType: 'public',
        target: { mode: 'pinned', revisionId },
        expiresAt: '2026-08-24T12:00:00.000Z',
      },
      { accessType: 'public', target: { mode: 'latest' }, expiresIn: 'never' },
      { accessType: 'public', target: { mode: 'latest' }, expiresIn: '30d' },
    ];

    for (const input of inputs) expect(isShareCreateInput(input)).toBe(true);
  });

  it('rejects conflicting, cross-mode, malformed, and out-of-bounds create inputs', () => {
    const invalidInputs = [
      {
        accessType: 'public',
        target: { mode: 'latest' },
        expiresIn: '24hr',
        expiresAt: '2026-08-24T12:00:00.000Z',
      },
      { accessType: 'public', target: { mode: 'latest' }, maxSessions: 1 },
      { accessType: 'public', target: { mode: 'latest' }, expiresIn: '31d' },
      { accessType: 'protected', target: { mode: 'latest' }, maxSessions: 0 },
      { accessType: 'protected', target: { mode: 'latest' }, maxSessions: 1_000_001 },
      { accessType: 'protected', target: { mode: 'latest' }, maxSessions: 1.5 },
      { accessType: 'protected', target: { mode: 'pinned' } },
      { accessType: 'protected', target: { mode: 'latest' }, revisionId },
      { accessType: 'protected', target: { mode: 'latest' }, expiresAt: null },
    ];

    for (const input of invalidInputs) expect(isShareCreateInput(input)).toBe(false);
  });

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

  it('accepts Public management state and rejects cross-mode result fields', () => {
    const publicSummary = {
      ...summary,
      target: { mode: 'latest' },
      accessType: 'public',
      expiresAt: '2026-08-19T12:00:00.000Z',
      status: 'expired',
      publicCode,
      url: `/s/${publicCode}`,
    };
    delete (publicSummary as Partial<typeof summary>).maxSessions;
    delete (publicSummary as Partial<typeof summary>).sessionsUsed;
    delete (publicSummary as Partial<typeof summary>).sessionsRemaining;

    expect(Check(ShareManagementSummarySchema, publicSummary)).toBe(true);
    expect(Check(ShareManagementSummarySchema, { ...publicSummary, expiresAt: null })).toBe(true);
    expect(
      Check(ShareCreateResultSchema, {
        ...publicSummary,
        target: { mode: 'pinned', revisionId },
        requestId: 'request-create-public-share',
        replayed: false,
      }),
    ).toBe(true);
    expect(
      Check(ShareManagementSummarySchema, {
        ...publicSummary,
        maxSessions: 5,
        sessionsUsed: 2,
        sessionsRemaining: 3,
      }),
    ).toBe(false);
    expect(
      Check(ShareManagementSummarySchema, {
        ...summary,
        publicCode,
        url: `/s/${publicCode}`,
      }),
    ).toBe(false);
  });

  it('requires coherent Protected usage and lifecycle state', () => {
    expect(Check(ShareManagementSummarySchema, summary)).toBe(true);
    expect(
      Check(ShareManagementSummarySchema, {
        ...summary,
        maxSessions: null,
        sessionsRemaining: null,
      }),
    ).toBe(true);
    expect(Check(ShareManagementSummarySchema, { ...summary, maxSessions: null })).toBe(false);
    expect(Check(ShareManagementSummarySchema, { ...summary, sessionsRemaining: null })).toBe(
      false,
    );
    expect(
      Check(ShareManagementSummarySchema, { ...summary, status: 'session-limit-reached' }),
    ).toBe(true);
    expect(Check(ShareManagementSummarySchema, { ...summary, status: 'deleted' })).toBe(false);
    expect(Check(ShareManagementSummarySchema, { ...summary, sessionsUsed: -1 })).toBe(false);
    expect(Check(ShareManagementSummarySchema, { ...summary, sessionsRemaining: -1 })).toBe(false);
  });

  it('accepts only 12-character base64url Public selectors and short URLs', () => {
    const valid = {
      ...summary,
      target: { mode: 'latest' },
      accessType: 'public',
      expiresAt: '2026-08-19T12:00:00.000Z',
      status: 'active',
      publicCode,
      url: `/s/${publicCode}`,
    };
    delete (valid as Partial<typeof summary>).maxSessions;
    delete (valid as Partial<typeof summary>).sessionsUsed;
    delete (valid as Partial<typeof summary>).sessionsRemaining;

    expect(Check(ShareManagementSummarySchema, valid)).toBe(true);
    expect(Check(ShareManagementSummarySchema, { ...valid, publicCode: 'too-short' })).toBe(false);
    expect(Check(ShareManagementSummarySchema, { ...valid, publicCode: 'AbCdEf0123+/' })).toBe(
      false,
    );
    expect(Check(ShareManagementSummarySchema, { ...valid, url: `/s/${publicCode}#secret` })).toBe(
      false,
    );
  });

  it('contracts successful anonymous Protected session authority without URL credentials', () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const authority = {
      apiVersion: 'v1',
      shareId,
      sessionId,
      token: 'v1.viewer-session.signed-authority',
      issuedAt: '2026-08-18T12:00:00.000Z',
      expiresAt: '2026-08-19T12:00:00.000Z',
    };

    expect(Check(ProtectedSessionAuthoritySchema, authority)).toBe(true);
    expect(isProtectedSessionAuthority(authority)).toBe(true);
    expect(isProtectedSessionAuthority({ ...authority, url: `/s/${shareId}#secret` })).toBe(false);
    expect(isProtectedSessionAuthority({ ...authority, sessionId: 'not-a-uuid' })).toBe(false);
    expect(
      Check(ProtectedSessionEstablishInputSchema, {
        sessionId,
        secret: 's'.repeat(43),
      }),
    ).toBe(true);
    expect(
      Check(ProtectedSessionEstablishInputSchema, {
        sessionId,
        token: authority.token,
      }),
    ).toBe(true);
    expect(Check(ProtectedSessionEstablishInputSchema, { sessionId })).toBe(false);
    expect(
      Check(ProtectedSessionEstablishInputSchema, {
        sessionId,
        secret: 's'.repeat(43),
        token: authority.token,
      }),
    ).toBe(false);
  });

  it('accepts a sanitized Protected file projection with a share-ID content action', () => {
    const resolution = {
      apiVersion: 'v1',
      accessType: 'protected',
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

  it('accepts a sanitized Protected folder projection with a share-ID tree action', () => {
    const resolution = {
      apiVersion: 'v1',
      accessType: 'protected',
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

  it('accepts a sanitized Public projection with a short-code action path', () => {
    const resolution = {
      apiVersion: 'v1',
      accessType: 'public',
      shareId,
      publicCode,
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
        path: `/api/v1/public/links/${publicCode}/content`,
      },
      expiresAt: null,
    };

    expect(Check(PublicShareResolutionSchema, resolution)).toBe(true);
    expect(isPublicShareResolution(resolution)).toBe(true);
    expect(
      isPublicShareResolution({
        ...resolution,
        action: { ...resolution.action, path: `/api/v1/public/shares/${shareId}/content` },
      }),
    ).toBe(false);
    expect(isPublicShareResolution({ ...resolution, publicCode: 'too-short' })).toBe(false);
  });

  it('maps non-enumerating share misses to the stable validation exit class', () => {
    expect(exitCodeForError('SHARE_NOT_FOUND')).toBe(CLI_EXIT_CODES.validation);
  });

  it('maps an expired artifact recovery to the stable validation exit class', () => {
    expect(exitCodeForError('ARTIFACT_RECOVERY_EXPIRED')).toBe(CLI_EXIT_CODES.validation);
  });
});
