import { describe, expect, it, vi } from 'vitest';

import {
  capabilityStorageKey,
  captureShareCapability,
  isPublicCode,
  isShareCapability,
  protectedSessionIdStorageKey,
  protectedViewerTokenStorageKey,
  readOrCreateProtectedSessionId,
  saveProtectedSessionAuthority,
  shareReferenceFromViewerPath,
} from '../src/capability.js';

const SHARE_ID = `shr_${'a'.repeat(22)}`;
const SECRET = 'A'.repeat(32);
const PUBLIC_CODE = 'AbCdEf0123_-';
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

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
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    storage.setItem(protectedViewerTokenStorageKey(SHARE_ID), 'viewer.token');
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
    storage.setItem(protectedSessionIdStorageKey(SHARE_ID), SESSION_ID);
    storage.setItem(protectedViewerTokenStorageKey(SHARE_ID), 'viewer.token');
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

  it('parses the complete legacy grammar before the exact Public selector grammar', () => {
    expect(shareReferenceFromViewerPath(`/s/${SHARE_ID}`)).toEqual({
      accessType: 'protected',
      shareId: SHARE_ID,
    });
    expect(shareReferenceFromViewerPath(`/s/${PUBLIC_CODE}`)).toEqual({
      accessType: 'public',
      publicCode: PUBLIC_CODE,
    });
    expect(shareReferenceFromViewerPath(`/s/${PUBLIC_CODE}x`)).toBeNull();
    expect(shareReferenceFromViewerPath(`/s/shr_${'a'.repeat(21)}`)).toBeNull();
    expect(isPublicCode(PUBLIC_CODE)).toBe(true);
  });

  it('creates one tab-scoped session id and replaces capability state with authority', () => {
    const storage = memoryStorage();
    storage.setItem(capabilityStorageKey(SHARE_ID), SECRET);
    expect(readOrCreateProtectedSessionId(SHARE_ID, storage, () => SESSION_ID)).toBe(SESSION_ID);
    expect(readOrCreateProtectedSessionId(SHARE_ID, storage, () => 'unused')).toBe(SESSION_ID);

    saveProtectedSessionAuthority(storage, {
      apiVersion: 'v1',
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      token: 'token.value',
      issuedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-20T00:00:00.000Z',
    });

    expect(storage.getItem(protectedSessionIdStorageKey(SHARE_ID))).toBe(SESSION_ID);
    expect(storage.getItem(protectedViewerTokenStorageKey(SHARE_ID))).toBe('token.value');
    expect(storage.getItem(capabilityStorageKey(SHARE_ID))).toBeNull();
  });
});
