import { describe, expect, it, vi } from 'vitest';

import {
  capabilityStorageKey,
  captureShareCapability,
  isShareCapability,
  shareIdFromViewerPath,
} from '../src/capability.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const SECRET = 'A'.repeat(32);

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

describe('share capability capture', () => {
  it('stores a valid fragment in tab-scoped storage and immediately scrubs the URL', () => {
    const storage = memoryStorage();
    const replaceState = vi.fn();

    const secret = captureShareCapability({
      shareId: SHARE_ID,
      location: { hash: `#${SECRET}`, pathname: `/s/${SHARE_ID}`, search: '' },
      history: { state: { from: 'link' }, replaceState },
      sessionStorage: storage,
    });

    expect(secret).toBe(SECRET);
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBe(SECRET);
    expect(replaceState).toHaveBeenCalledWith({ from: 'link' }, '', `/s/${SHARE_ID}`);
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(SECRET);
  });

  it('recovers the secret on a tab reload without putting it back in the URL', () => {
    const storage = memoryStorage();
    storage.setItem(capabilityStorageKey(SHARE_ID), SECRET);
    const replaceState = vi.fn();

    expect(
      captureShareCapability({
        shareId: SHARE_ID,
        location: { hash: '', pathname: `/s/${SHARE_ID}`, search: '' },
        history: { state: null, replaceState },
        sessionStorage: storage,
      }),
    ).toBe(SECRET);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('scrubs a malformed fragment and never persists it', () => {
    const storage = memoryStorage();
    storage.setItem(capabilityStorageKey(SHARE_ID), SECRET);
    const replaceState = vi.fn();

    expect(
      captureShareCapability({
        shareId: SHARE_ID,
        location: { hash: '#not valid', pathname: `/s/${SHARE_ID}`, search: '?preview=1' },
        history: { state: null, replaceState },
        sessionStorage: storage,
      }),
    ).toBeNull();
    expect(storage.length).toBe(0);
    expect(replaceState).toHaveBeenCalledWith(null, '', `/s/${SHARE_ID}?preview=1`);
  });

  it('accepts only the share-link capability alphabet and length', () => {
    expect(isShareCapability(SECRET)).toBe(true);
    expect(isShareCapability('A'.repeat(31))).toBe(false);
    expect(isShareCapability(`${'A'.repeat(31)}+`)).toBe(false);
  });

  it('extracts a share id only from the anonymous viewer route', () => {
    expect(shareIdFromViewerPath(`/s/${SHARE_ID}`)).toBe(SHARE_ID);
    expect(shareIdFromViewerPath(`/s/${SHARE_ID}/`)).toBe(SHARE_ID);
    expect(shareIdFromViewerPath(`/dashboard/s/${SHARE_ID}`)).toBeNull();
  });
});
