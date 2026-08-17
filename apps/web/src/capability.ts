const SHARE_ID_PATTERN = /^shr_[A-Za-z0-9_-]{22}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

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

export function shareIdFromViewerPath(pathname: string): string | null {
  const match = /^\/s\/(shr_[A-Za-z0-9_-]{22})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

export function capabilityStorageKey(shareId: string): string {
  return `shelf:share-capability:${shareId}`;
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
