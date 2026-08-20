export type ReviewPersistenceKey = `shelf:review-${string}`;

function browserStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readReviewValue(key: ReviewPersistenceKey): string | null {
  try {
    return browserStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeReviewValue(key: ReviewPersistenceKey, value: string): void {
  try {
    browserStore()?.setItem(key, value);
  } catch {
    // Review state remains usable for this tab when browser storage is unavailable.
  }
}

export function removeReviewValue(key: ReviewPersistenceKey): void {
  try {
    browserStore()?.removeItem(key);
  } catch {
    // Review state remains usable for this tab when browser storage is unavailable.
  }
}

export function reviewVisitorKey(): ReviewPersistenceKey {
  return 'shelf:review-visitor:v1';
}

const reviewReadPrefix = 'shelf:review-read:';
const reviewReadMaxEntries = 100;
const reviewReadMaxAgeMs = 30 * 24 * 60 * 60 * 1000;

function reviewThreadReadKey(artifactId: string, threadId: string): ReviewPersistenceKey {
  return `${reviewReadPrefix}${encodeURIComponent(artifactId)}:${encodeURIComponent(threadId)}`;
}

function reviewInstant(value: string | null): number | undefined {
  if (value === null) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

interface ReviewReadMarker {
  readonly readThrough: string;
  readonly expiresAt: number;
}

function parseReviewReadMarker(value: string | null): ReviewReadMarker | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'readThrough' in parsed &&
      typeof parsed.readThrough === 'string' &&
      'expiresAt' in parsed &&
      typeof parsed.expiresAt === 'number' &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return { readThrough: parsed.readThrough, expiresAt: parsed.expiresAt };
    }
  } catch {
    // Read markers from the initial implementation were plain timestamps.
  }
  const legacyReadThrough = reviewInstant(value);
  return legacyReadThrough === undefined
    ? undefined
    : { readThrough: value, expiresAt: legacyReadThrough + reviewReadMaxAgeMs };
}

function pruneReviewReadMarkers(now: number): void {
  const storage = browserStore();
  if (storage === undefined) return;
  try {
    const markers: Array<{ key: string; expiresAt: number }> = [];
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(reviewReadPrefix)) continue;
      const marker = parseReviewReadMarker(storage.getItem(key));
      if (marker === undefined || marker.expiresAt <= now) {
        storage.removeItem(key);
        continue;
      }
      markers.push({ key, expiresAt: marker.expiresAt });
    }
    markers.sort((left, right) => left.expiresAt - right.expiresAt);
    for (const marker of markers.slice(0, Math.max(0, markers.length - reviewReadMaxEntries))) {
      storage.removeItem(marker.key);
    }
  } catch {
    // Review state remains usable when browser storage is unavailable.
  }
}

export function isReviewThreadRead(
  artifactId: string,
  threadId: string,
  latestActivityAt: string | null,
): boolean {
  const latestActivity = reviewInstant(latestActivityAt);
  const key = reviewThreadReadKey(artifactId, threadId);
  const marker = parseReviewReadMarker(readReviewValue(key));
  if (marker === undefined || marker.expiresAt <= Date.now()) {
    removeReviewValue(key);
    return false;
  }
  const readThrough = reviewInstant(marker.readThrough);
  return latestActivity !== undefined && readThrough !== undefined && readThrough >= latestActivity;
}

export function markReviewThreadRead(
  artifactId: string,
  threadId: string,
  latestActivityAt: string,
): void {
  if (reviewInstant(latestActivityAt) === undefined) return;
  const now = Date.now();
  writeReviewValue(
    reviewThreadReadKey(artifactId, threadId),
    JSON.stringify({
      readThrough: latestActivityAt,
      expiresAt: now + reviewReadMaxAgeMs,
    }),
  );
  pruneReviewReadMarkers(now);
}
