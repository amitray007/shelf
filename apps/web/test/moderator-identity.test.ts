import { afterEach, describe, expect, it } from 'vitest';

import {
  readModeratorDisplayName,
  saveModeratorDisplayName,
} from '../src/components/review/moderator-identity.js';

const moderatorNameKey = 'shelf:review-moderator:v1';
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });
  return storage;
}

afterEach(() => {
  if (originalWindowDescriptor === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
});

describe('moderator display name', () => {
  it('reports an empty name before anything is saved', () => {
    installStorage();
    expect(readModeratorDisplayName()).toBe('');
  });

  it('saves a trimmed name and reads it back', () => {
    const storage = installStorage();

    expect(saveModeratorDisplayName('  Ada Lovelace  ')).toBe('Ada Lovelace');
    expect(storage.getItem(moderatorNameKey)).toBe('Ada Lovelace');
    expect(readModeratorDisplayName()).toBe('Ada Lovelace');
  });

  it('clears the stored name when the input trims to nothing', () => {
    const storage = installStorage();
    saveModeratorDisplayName('Ada');

    expect(saveModeratorDisplayName('   ')).toBe('');
    expect(storage.getItem(moderatorNameKey)).toBeNull();
    expect(readModeratorDisplayName()).toBe('');
  });

  it('rejects a name longer than the 128 character contract limit', () => {
    const storage = installStorage();
    saveModeratorDisplayName('Ada');

    expect(saveModeratorDisplayName('n'.repeat(129))).toBe('');
    expect(storage.getItem(moderatorNameKey)).toBeNull();
    expect(saveModeratorDisplayName('n'.repeat(128))).toBe('n'.repeat(128));
  });

  it('ignores a persisted value that no longer satisfies the contract', () => {
    const storage = installStorage();

    storage.setItem(moderatorNameKey, '   ');
    expect(readModeratorDisplayName()).toBe('');

    storage.setItem(moderatorNameKey, 'n'.repeat(129));
    expect(readModeratorDisplayName()).toBe('');

    storage.setItem(moderatorNameKey, '  Grace  ');
    expect(readModeratorDisplayName()).toBe('Grace');
  });

  it('keeps the session usable when browser storage is unavailable', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage(): Storage {
          throw new Error('Storage is blocked');
        },
      },
    });

    expect(() => saveModeratorDisplayName('Ada')).not.toThrow();
    expect(readModeratorDisplayName()).toBe('');
  });
});
