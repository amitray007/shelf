import { describe, expect, it } from 'vitest';

import {
  createFolderSessionCodec,
  deriveFolderSessionKey,
  type FolderSessionClaims,
} from '../src/folder-session.js';

const now = new Date('2026-08-17T12:00:00.000Z');
const claims: FolderSessionClaims = {
  authority: {
    type: 'protected-session',
    shareId: 'shr_AAAAAAAAAAAAAAAAAAAAAA',
    sessionId: '123e4567-e89b-42d3-a456-426614174000',
  },
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  nonce: 'n'.repeat(22),
  expiresAt: now.getTime() + 60_000,
};

describe('folder session tokens', () => {
  it('round-trips exact claims as one URL path segment', () => {
    const codec = createFolderSessionCodec(deriveFolderSessionKey('share-signing-key'));
    const token = codec.issue(claims);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(codec.verify(token, now)).toEqual(claims);
  });

  it('verifies across renderer instances that derive the same key', () => {
    const token = createFolderSessionCodec(deriveFolderSessionKey('share-signing-key')).issue(
      claims,
    );

    expect(
      createFolderSessionCodec(deriveFolderSessionKey('share-signing-key')).verify(token, now),
    ).toEqual(claims);
    expect(
      createFolderSessionCodec(deriveFolderSessionKey('another-key')).verify(token, now),
    ).toBeUndefined();
  });

  it('rejects expired, tampered, and malformed tokens', () => {
    const codec = createFolderSessionCodec();
    const token = codec.issue(claims);
    const [payload = '', signature = ''] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC' }),
    ).toString('base64url');

    expect(codec.verify(token, new Date(claims.expiresAt))).toBeUndefined();
    expect(codec.verify(`${forged}.${signature}`, now)).toBeUndefined();
    expect(codec.verify(`${payload}.${'A'.repeat(43)}`, now)).toBeUndefined();
    expect(codec.verify(payload, now)).toBeUndefined();
    expect(codec.verify('', now)).toBeUndefined();
  });

  it('rejects signed payloads with unexpected claims', () => {
    const codec = createFolderSessionCodec();
    const token = codec.issue({
      ...claims,
      authority: { type: 'public', publicCode: 'not-a-valid-public-code' },
    });

    expect(codec.verify(token, now)).toBeUndefined();
  });
});
