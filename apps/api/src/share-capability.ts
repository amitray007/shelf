import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ShareCapabilityCodec } from '@shelf/core';

const SHARE_CAPABILITY_DOMAIN = 'shelf/share-capability/v1\0';
const VIEWER_SESSION_DOMAIN = 'shelf/protected-viewer-session/v1\0';
const VIEWER_SESSION_PURPOSE = 'protected-viewer-session';
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{100,3072}\.[A-Za-z0-9_-]{43}$/u;

export interface ViewerSessionTokenClaims {
  readonly shareId: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly accessExpiresAt: string;
}

export interface ViewerSessionTokenCodec {
  issue(claims: ViewerSessionTokenClaims): string;
  verify(
    token: string,
    options: {
      now: Date;
      shareId?: string;
      sessionId?: string;
      allowExpired?: boolean;
    },
  ): ViewerSessionTokenClaims | undefined;
}

interface TokenPayload extends ViewerSessionTokenClaims {
  v: 1;
  purpose: typeof VIEWER_SESSION_PURPOSE;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseTokenPayload(encoded: string): TokenPayload | undefined {
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded || decoded.byteLength > 2048) return undefined;
    const value = JSON.parse(decoded.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const payload = value as Partial<TokenPayload> & Record<string, unknown>;
    if (
      Object.keys(payload).sort().join(',') !==
        'accessExpiresAt,issuedAt,purpose,sessionId,shareId,v' ||
      payload.v !== 1 ||
      payload.purpose !== VIEWER_SESSION_PURPOSE ||
      typeof payload.shareId !== 'string' ||
      !SHARE_ID_PATTERN.test(payload.shareId) ||
      typeof payload.sessionId !== 'string' ||
      !SESSION_ID_PATTERN.test(payload.sessionId) ||
      !validInstant(payload.issuedAt) ||
      !validInstant(payload.accessExpiresAt) ||
      Date.parse(payload.accessExpiresAt) <= Date.parse(payload.issuedAt)
    ) {
      return undefined;
    }
    return payload as TokenPayload;
  } catch {
    return undefined;
  }
}

/**
 * Build a stateless capability codec. The key is copied on construction and must be dedicated to
 * share signing; raw capability material never needs to be persisted.
 */
export function createHmacShareCapabilityCodec(
  signingKey: string | Uint8Array,
): ShareCapabilityCodec {
  const key = Buffer.from(signingKey);
  if (key.byteLength < 32) {
    throw new Error('Shelf share capability signing keys must contain at least 32 bytes.');
  }

  function deriveSecret(shareId: string): string {
    if (!SHARE_ID_PATTERN.test(shareId)) {
      throw new Error('Cannot derive a capability for an invalid share ID.');
    }
    return createHmac('sha256', key)
      .update(SHARE_CAPABILITY_DOMAIN, 'utf8')
      .update(shareId, 'utf8')
      .digest('base64url');
  }

  return Object.freeze({
    deriveSecret,
    validateSecret(shareId: string, secret: string): boolean {
      if (!SHARE_ID_PATTERN.test(shareId) || !CAPABILITY_PATTERN.test(secret)) return false;
      const expected = Buffer.from(deriveSecret(shareId), 'ascii');
      const supplied = Buffer.from(secret, 'ascii');
      return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
    },
  });
}

/**
 * Build the domain-separated bearer-token codec from the same durable installation key used for
 * share capabilities. Tokens contain no capability and are bounded before parsing.
 */
export function createHmacViewerSessionTokenCodec(
  signingKey: string | Uint8Array,
): ViewerSessionTokenCodec {
  const rootKey = Buffer.from(signingKey);
  if (rootKey.byteLength < 32) {
    throw new Error('Shelf share capability signing keys must contain at least 32 bytes.');
  }
  const key = createHmac('sha256', rootKey).update(VIEWER_SESSION_DOMAIN, 'utf8').digest();

  return Object.freeze({
    issue(claims: ViewerSessionTokenClaims): string {
      if (
        !SHARE_ID_PATTERN.test(claims.shareId) ||
        !SESSION_ID_PATTERN.test(claims.sessionId) ||
        !validInstant(claims.issuedAt) ||
        !validInstant(claims.accessExpiresAt) ||
        Date.parse(claims.accessExpiresAt) <= Date.parse(claims.issuedAt)
      ) {
        throw new Error('Cannot issue a viewer-session token with invalid claims.');
      }
      const payload: TokenPayload = {
        v: 1,
        purpose: VIEWER_SESSION_PURPOSE,
        shareId: claims.shareId,
        sessionId: claims.sessionId,
        issuedAt: claims.issuedAt,
        accessExpiresAt: claims.accessExpiresAt,
      };
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const signature = createHmac('sha256', key).update(encoded, 'ascii').digest('base64url');
      return `${encoded}.${signature}`;
    },
    verify(
      token: string,
      options: {
        now: Date;
        shareId?: string;
        sessionId?: string;
        allowExpired?: boolean;
      },
    ): ViewerSessionTokenClaims | undefined {
      if (!TOKEN_PATTERN.test(token)) return undefined;
      const separator = token.indexOf('.');
      if (separator <= 0 || separator !== token.lastIndexOf('.')) return undefined;
      const encoded = token.slice(0, separator);
      const supplied = Buffer.from(token.slice(separator + 1), 'ascii');
      const expected = Buffer.from(
        createHmac('sha256', key).update(encoded, 'ascii').digest('base64url'),
        'ascii',
      );
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
        return undefined;
      }
      const payload = parseTokenPayload(encoded);
      if (payload === undefined) return undefined;
      const now = options.now.getTime();
      if (
        !Number.isFinite(now) ||
        Date.parse(payload.issuedAt) > now ||
        (options.allowExpired !== true && Date.parse(payload.accessExpiresAt) <= now) ||
        (options.shareId !== undefined && payload.shareId !== options.shareId) ||
        (options.sessionId !== undefined && payload.sessionId !== options.sessionId)
      ) {
        return undefined;
      }
      return {
        shareId: payload.shareId,
        sessionId: payload.sessionId,
        issuedAt: payload.issuedAt,
        accessExpiresAt: payload.accessExpiresAt,
      };
    },
  });
}

export function createHmacShareSecurityCodecs(signingKey: string | Uint8Array): {
  capability: ShareCapabilityCodec;
  viewerSession: ViewerSessionTokenCodec;
} {
  return {
    capability: createHmacShareCapabilityCodec(signingKey),
    viewerSession: createHmacViewerSessionTokenCodec(signingKey),
  };
}
