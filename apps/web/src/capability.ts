const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/;
const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{12}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ViewerShareReference =
  | { readonly accessType: 'protected'; readonly shareId: string }
  | { readonly accessType: 'public'; readonly publicCode: string };

export interface ProtectedSessionAuthority {
  readonly apiVersion: 'v1';
  readonly shareId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface CapabilityLocation {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

interface CapabilityHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface CaptureShareCapabilityInput {
  readonly shareId: string;
  readonly location: CapabilityLocation;
  readonly history: CapabilityHistory;
  readonly sessionStorage: Storage;
}

export function isShareId(value: string): boolean {
  return SHARE_ID_PATTERN.test(value);
}

export function isShareCapability(value: string): boolean {
  return CAPABILITY_PATTERN.test(value);
}

export function isPublicCode(value: string): boolean {
  return PUBLIC_CODE_PATTERN.test(value);
}

export function isProtectedSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function shareIdFromViewerPath(pathname: string): string | null {
  const match = /^\/s\/(shr_[A-Za-z0-9_-]{22})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function shareReferenceFromViewerPath(pathname: string): ViewerShareReference | null {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  const value = match?.[1] ?? '';
  if (isShareId(value)) return { accessType: 'protected', shareId: value };
  if (isPublicCode(value)) return { accessType: 'public', publicCode: value };
  return null;
}

export function capabilityStorageKey(shareId: string): string {
  return `shelf:share-capability:${shareId}`;
}

export function protectedSessionIdStorageKey(shareId: string): string {
  return `shelf:protected-session-id:${shareId}`;
}

export function protectedViewerTokenStorageKey(shareId: string): string {
  return `shelf:protected-viewer-token:${shareId}`;
}

export function readOrCreateProtectedSessionId(
  shareId: string,
  sessionStorage: Storage,
  randomUUID: () => string = () => crypto.randomUUID(),
): string | null {
  if (!isShareId(shareId)) return null;
  try {
    const existing = sessionStorage.getItem(protectedSessionIdStorageKey(shareId));
    if (existing !== null && isProtectedSessionId(existing)) return existing;
    const created = randomUUID();
    if (!isProtectedSessionId(created)) return null;
    sessionStorage.setItem(protectedSessionIdStorageKey(shareId), created);
    return created;
  } catch {
    return null;
  }
}

export function readProtectedViewerToken(shareId: string, sessionStorage: Storage): string | null {
  try {
    const token = sessionStorage.getItem(protectedViewerTokenStorageKey(shareId));
    return token !== null && token.length >= 24 && token.length <= 4096 ? token : null;
  } catch {
    return null;
  }
}

export function saveProtectedSessionAuthority(
  sessionStorage: Storage,
  authority: ProtectedSessionAuthority,
): void {
  try {
    sessionStorage.setItem(protectedSessionIdStorageKey(authority.shareId), authority.sessionId);
    sessionStorage.setItem(protectedViewerTokenStorageKey(authority.shareId), authority.token);
    sessionStorage.removeItem(capabilityStorageKey(authority.shareId));
  } catch {
    // A viewer can still use the returned authority for this navigation.
  }
}

export function captureShareCapability(input: CaptureShareCapabilityInput): string | null {
  if (!isShareId(input.shareId)) return null;

  const fragment = input.location.hash.startsWith('#')
    ? input.location.hash.slice(1)
    : input.location.hash;

  if (input.location.hash.length > 0) {
    input.history.replaceState(
      input.history.state,
      '',
      `${input.location.pathname}${input.location.search}`,
    );

    if (!isShareCapability(fragment)) {
      try {
        input.sessionStorage.removeItem(capabilityStorageKey(input.shareId));
        input.sessionStorage.removeItem(protectedSessionIdStorageKey(input.shareId));
        input.sessionStorage.removeItem(protectedViewerTokenStorageKey(input.shareId));
      } catch {
        // The malformed incoming capability still supersedes any older tab state.
      }
      return null;
    }

    try {
      input.sessionStorage.setItem(capabilityStorageKey(input.shareId), fragment);
    } catch {
      // The current navigation can continue even when storage is unavailable.
    }
    return fragment;
  }

  try {
    const stored = input.sessionStorage.getItem(capabilityStorageKey(input.shareId));
    return stored !== null && isShareCapability(stored) ? stored : null;
  } catch {
    return null;
  }
}
