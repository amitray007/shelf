import { readReviewValue, reviewVisitorKey, writeReviewValue } from './persistence.js';

export interface ReviewVisitorIdentity {
  readonly visitorToken: string;
  readonly displayName: string;
}

let memoryIdentity: ReviewVisitorIdentity | undefined;

function randomToken(): string | null {
  const bytes = new Uint8Array(32);
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return null;
  try {
    crypto.getRandomValues(bytes);
  } catch {
    return null;
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === 'function'
    ? btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    : null;
}

function validIdentity(value: unknown): value is ReviewVisitorIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'visitorToken' in value &&
    typeof value.visitorToken === 'string' &&
    value.visitorToken.length >= 32 &&
    value.visitorToken.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value.visitorToken) &&
    'displayName' in value &&
    typeof value.displayName === 'string' &&
    value.displayName.length <= 128
  );
}

function validDisplayName(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128;
}

export function readReviewVisitorIdentity(): ReviewVisitorIdentity {
  if (memoryIdentity !== undefined) return memoryIdentity;
  try {
    const value: unknown = JSON.parse(readReviewValue(reviewVisitorKey()) ?? 'null');
    if (validIdentity(value)) {
      memoryIdentity = value;
      return value;
    }
  } catch {
    // Continue with an in-memory identity when the browser value is unavailable.
  }
  const token = randomToken();
  memoryIdentity = { visitorToken: token ?? '', displayName: '' };
  if (token === null) return memoryIdentity;
  writeReviewValue(reviewVisitorKey(), JSON.stringify(memoryIdentity));
  return memoryIdentity;
}

export function saveReviewVisitorIdentity(identity: ReviewVisitorIdentity): ReviewVisitorIdentity {
  const next = { visitorToken: identity.visitorToken, displayName: identity.displayName.trim() };
  if (!validIdentity(next) || !validDisplayName(next.displayName))
    return readReviewVisitorIdentity();
  memoryIdentity = next;
  writeReviewValue(reviewVisitorKey(), JSON.stringify(next));
  return next;
}

export function canWriteReview(identity: ReviewVisitorIdentity): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(identity.visitorToken);
}
