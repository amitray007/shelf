import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createHmacShareCapabilityCodec,
  createHmacViewerSessionTokenCodec,
} from '../src/share-capability.js';

const shareId = 'shr_AAAAAAAAAAAAAAAAAAAAAA';

describe('HMAC share capability codec', () => {
  it('derives stable, domain-separated capability material and validates it timing-safely', () => {
    const codec = createHmacShareCapabilityCodec(Buffer.alloc(32, 7));
    const otherKey = createHmacShareCapabilityCodec(Buffer.alloc(32, 8));

    const secret = codec.deriveSecret(shareId);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(codec.deriveSecret(shareId)).toBe(secret);
    expect(codec.validateSecret(shareId, secret)).toBe(true);
    const replacement = secret.endsWith('x') ? 'y' : 'x';
    expect(codec.validateSecret(shareId, `${secret.slice(0, -1)}${replacement}`)).toBe(false);
    expect(otherKey.validateSecret(shareId, secret)).toBe(false);
    expect(codec.validateSecret('shr_BBBBBBBBBBBBBBBBBBBBBB', secret)).toBe(false);
  });

  it('rejects signing keys shorter than 32 bytes', () => {
    expect(() => createHmacShareCapabilityCodec(Buffer.alloc(31))).toThrow(/32 bytes/u);
  });
});

describe('HMAC protected viewer-session token codec', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const issuedAt = '2026-08-18T12:00:00.000Z';
  const accessExpiresAt = '2026-08-19T12:00:00.000Z';

  it('binds versioned authority to one share and UUID session', () => {
    const codec = createHmacViewerSessionTokenCodec(Buffer.alloc(32, 7));
    const token = codec.issue({ shareId, sessionId, issuedAt, accessExpiresAt });

    expect(codec.verify(token, { now: new Date(issuedAt), shareId, sessionId })).toEqual({
      shareId,
      sessionId,
      issuedAt,
      accessExpiresAt,
    });
    expect(
      codec.verify(token, {
        now: new Date(issuedAt),
        shareId: 'shr_BBBBBBBBBBBBBBBBBBBBBB',
        sessionId,
      }),
    ).toBeUndefined();
    expect(
      codec.verify(token, {
        now: new Date(issuedAt),
        shareId,
        sessionId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBeUndefined();
  });

  it('rejects modified, malformed, oversized, future-issued, and expired authorization tokens', () => {
    const codec = createHmacViewerSessionTokenCodec(Buffer.alloc(32, 7));
    const token = codec.issue({ shareId, sessionId, issuedAt, accessExpiresAt });
    const [payload, signature] = token.split('.') as [string, string];
    const replacement = signature.endsWith('x') ? 'y' : 'x';

    expect(
      codec.verify(`${payload}.${signature.slice(0, -1)}${replacement}`, {
        now: new Date(issuedAt),
      }),
    ).toBeUndefined();
    expect(
      codec.verify(`${payload.slice(0, -1)}x.${signature}`, { now: new Date(issuedAt) }),
    ).toBeUndefined();
    expect(codec.verify('not-a-token', { now: new Date(issuedAt) })).toBeUndefined();
    expect(
      codec.verify(`${'a'.repeat(4096)}.${signature}`, { now: new Date(issuedAt) }),
    ).toBeUndefined();
    expect(codec.verify(token, { now: new Date('2026-08-18T11:59:59.999Z') })).toBeUndefined();
    expect(codec.verify(token, { now: new Date(accessExpiresAt) })).toBeUndefined();
    expect(
      codec.verify(token, { now: new Date(accessExpiresAt), allowExpired: true }),
    ).toMatchObject({ shareId, sessionId });
  });

  it('uses a separate signing domain from capability material', () => {
    const key = Buffer.alloc(32, 7);
    const capability = createHmacShareCapabilityCodec(key).deriveSecret(shareId);
    const token = createHmacViewerSessionTokenCodec(key).issue({
      shareId,
      sessionId,
      issuedAt,
      accessExpiresAt,
    });

    expect(token).not.toContain(capability);
  });

  it('rejects an authentic token payload with the wrong purpose', () => {
    const rootKey = Buffer.alloc(32, 7);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        purpose: 'some-other-purpose',
        shareId,
        sessionId,
        issuedAt,
        accessExpiresAt,
      }),
      'utf8',
    ).toString('base64url');
    const tokenKey = createHmac('sha256', rootKey)
      .update('shelf/protected-viewer-session/v1\0', 'utf8')
      .digest();
    const signature = createHmac('sha256', tokenKey).update(payload, 'ascii').digest('base64url');

    expect(
      createHmacViewerSessionTokenCodec(rootKey).verify(`${payload}.${signature}`, {
        now: new Date(issuedAt),
      }),
    ).toBeUndefined();
  });
});
