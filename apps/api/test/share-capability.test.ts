import { describe, expect, it } from 'vitest';

import { createHmacShareCapabilityCodec } from '../src/share-capability.js';

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
