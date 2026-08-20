import { afterEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function deterministicCrypto(): Crypto {
  return {
    getRandomValues<T extends ArrayBufferView | null>(array: T): T {
      if (array === null) return array;
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
      return array;
    },
  } as Crypto;
}

async function loadIdentityModule() {
  vi.resetModules();
  return import('../src/components/review/identity.js');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('review visitor identity', () => {
  it('creates a high-entropy token once and reuses the browser value', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('crypto', deterministicCrypto());
    const identity = await loadIdentityModule();

    const first = identity.readReviewVisitorIdentity();
    const second = identity.readReviewVisitorIdentity();

    expect(first).toEqual(second);
    expect(first.visitorToken).toHaveLength(43);
    expect(identity.canWriteReview(first)).toBe(true);
    expect(storage.getItem(identityKey())).toContain(first.visitorToken);
  });

  it('rejects malformed persisted values and replaces them with a valid token', async () => {
    const storage = memoryStorage();
    storage.setItem(identityKey(), '{not-json');
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('crypto', deterministicCrypto());
    const identity = await loadIdentityModule();

    const value = identity.readReviewVisitorIdentity();

    expect(value.visitorToken).toHaveLength(43);
    expect(JSON.parse(storage.getItem(identityKey()) ?? 'null')).toMatchObject({
      visitorToken: value.visitorToken,
    });
  });

  it('keeps the current tab usable when browser storage is unavailable', async () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('Storage is blocked');
      },
    });
    vi.stubGlobal('crypto', deterministicCrypto());
    const identity = await loadIdentityModule();

    expect(() => identity.readReviewVisitorIdentity()).not.toThrow();
    expect(identity.canWriteReview(identity.readReviewVisitorIdentity())).toBe(true);
  });

  it('disables writes when secure randomness is unavailable', async () => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
    vi.stubGlobal('crypto', undefined);
    const identity = await loadIdentityModule();

    const value = identity.readReviewVisitorIdentity();

    expect(value.visitorToken).toBe('');
    expect(identity.canWriteReview(value)).toBe(false);
  });

  it('trims and requires a non-empty display name without weakening token validation', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('crypto', deterministicCrypto());
    const identity = await loadIdentityModule();
    const initial = identity.readReviewVisitorIdentity();

    expect(identity.saveReviewVisitorIdentity({ ...initial, displayName: '  Ada  ' })).toEqual({
      visitorToken: initial.visitorToken,
      displayName: 'Ada',
    });
    expect(identity.saveReviewVisitorIdentity({ ...initial, displayName: '   ' })).toEqual({
      visitorToken: initial.visitorToken,
      displayName: 'Ada',
    });
    expect(identity.canWriteReview({ visitorToken: 'a'.repeat(31), displayName: 'Ada' })).toBe(
      false,
    );
    expect(identity.canWriteReview({ visitorToken: 'a'.repeat(32), displayName: 'Ada' })).toBe(
      true,
    );
    expect(
      identity.canWriteReview({ visitorToken: `${'a'.repeat(31)}!`, displayName: 'Ada' }),
    ).toBe(false);
  });
});

function identityKey(): `shelf:review-${string}` {
  return 'shelf:review-visitor:v1';
}
