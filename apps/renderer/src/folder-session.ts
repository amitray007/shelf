import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ShareResolutionAuthority } from '@shelf/core';

const FOLDER_SESSION_DOMAIN = 'shelf/renderer-folder-session/v1\0';
const FOLDER_SESSION_KEY_LABEL = 'shelf/renderer-folder-session-key/v1';
export const FOLDER_SESSION_TTL_MS = 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,1024}\.[A-Za-z0-9_-]{43}$/u;
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION_ID_PATTERN = /^rev_[A-Za-z0-9_-]{22}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

/**
 * A folder session lets one rendered folder document load sibling files from one exact revision.
 * The token names the share authority, but every file read still resolves that authority again.
 */
export interface FolderSessionClaims {
  readonly authority: ShareResolutionAuthority;
  readonly revisionId: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface FolderSessionCodec {
  issue(claims: FolderSessionClaims): string;
  verify(token: string, now: Date): FolderSessionClaims | undefined;
}

/** Derive the folder-session key from the share-signing key so every renderer replica agrees. */
export function deriveFolderSessionKey(shareSigningKey: string | Uint8Array): Uint8Array {
  return createHmac('sha256', shareSigningKey).update(FOLDER_SESSION_KEY_LABEL).digest();
}

function validAuthority(value: unknown): value is ShareResolutionAuthority {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const authority = value as Record<string, unknown>;
  const keys = Object.keys(authority).sort().join(',');
  if (authority.type === 'public') {
    return (
      keys === 'publicCode,type' &&
      typeof authority.publicCode === 'string' &&
      PUBLIC_CODE_PATTERN.test(authority.publicCode)
    );
  }
  return (
    authority.type === 'protected-session' &&
    keys === 'sessionId,shareId,type' &&
    typeof authority.shareId === 'string' &&
    SHARE_ID_PATTERN.test(authority.shareId) &&
    typeof authority.sessionId === 'string' &&
    SESSION_ID_PATTERN.test(authority.sessionId)
  );
}

function parseClaims(encoded: string): FolderSessionClaims | undefined {
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return undefined;
    const value = JSON.parse(decoded.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const claims = value as Record<string, unknown>;
    if (
      Object.keys(claims).sort().join(',') !== 'authority,expiresAt,nonce,revisionId' ||
      !validAuthority(claims.authority) ||
      typeof claims.revisionId !== 'string' ||
      !REVISION_ID_PATTERN.test(claims.revisionId) ||
      typeof claims.nonce !== 'string' ||
      !NONCE_PATTERN.test(claims.nonce) ||
      typeof claims.expiresAt !== 'number' ||
      !Number.isSafeInteger(claims.expiresAt)
    ) {
      return undefined;
    }
    return claims as unknown as FolderSessionClaims;
  } catch {
    return undefined;
  }
}

export function createFolderSessionCodec(key: Uint8Array = randomBytes(32)): FolderSessionCodec {
  const signingKey = Buffer.from(key);
  const sign = (payload: string) =>
    createHmac('sha256', signingKey).update(FOLDER_SESSION_DOMAIN).update(payload).digest();

  return {
    issue(claims) {
      const payload = Buffer.from(
        JSON.stringify({
          authority: claims.authority,
          revisionId: claims.revisionId,
          nonce: claims.nonce,
          expiresAt: claims.expiresAt,
        }),
      ).toString('base64url');
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(token, now) {
      if (!TOKEN_PATTERN.test(token)) return undefined;
      const [payload = '', signature = ''] = token.split('.');
      const expected = sign(payload);
      const actual = Buffer.from(signature, 'base64url');
      if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
        return undefined;
      }
      const claims = parseClaims(payload);
      return claims !== undefined && claims.expiresAt > now.getTime() ? claims : undefined;
    },
  };
}
