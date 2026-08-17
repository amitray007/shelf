import { createHmac, timingSafeEqual } from 'node:crypto';

import type { ShareCapabilityCodec } from '@shelf/core';

const SHARE_CAPABILITY_DOMAIN = 'shelf/share-capability/v1\0';
const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/u;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

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
