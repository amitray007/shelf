import { afterEach, describe, expect, it, vi } from 'vitest';

import { isReviewThreadRead, markReviewThreadRead } from '../src/components/review/persistence.js';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } as Storage;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  });
}

afterEach(() => {
  vi.useRealTimers();
  if (originalWindowDescriptor === undefined) delete (globalThis as { window?: unknown }).window;
  else Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
});

describe('review thread read persistence', () => {
  it('treats a newer read-through marker as read and an older marker as unread', () => {
    installStorage();
    const artifactId = 'art_read_state';
    const threadId = 'thread_read_state';

    markReviewThreadRead(artifactId, threadId, '2026-08-19T00:00:20.000Z');

    expect(isReviewThreadRead(artifactId, threadId, '2026-08-19T00:00:10.000Z')).toBe(true);
    expect(isReviewThreadRead(artifactId, threadId, '2026-08-19T00:00:30.000Z')).toBe(false);
  });

  it('does not treat invalid instants as read state', () => {
    installStorage();
    markReviewThreadRead('art_invalid', 'thread_invalid', 'not-a-date');
    expect(isReviewThreadRead('art_invalid', 'thread_invalid', '2026-08-19T00:00:00.000Z')).toBe(
      false,
    );
  });

  it('expires read markers after thirty days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    installStorage();
    markReviewThreadRead('art_expiring', 'thread_expiring', '2026-08-19T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-09-19T00:00:01.000Z'));
    expect(isReviewThreadRead('art_expiring', 'thread_expiring', '2026-08-19T00:00:00.000Z')).toBe(
      false,
    );
  });

  it('keeps at most one hundred read markers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    installStorage();
    for (let index = 0; index < 105; index += 1) {
      markReviewThreadRead(`art_cap_${index}`, 'thread_cap', '2026-08-19T00:00:00.000Z');
    }

    const storage = (globalThis.window as Window).localStorage;
    const markerCount = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).filter((key): key is string => key?.startsWith('shelf:review-read:') === true).length;
    expect(markerCount).toBe(100);
  });
});
