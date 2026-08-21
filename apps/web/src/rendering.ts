export type PassiveRenderer =
  | { readonly kind: 'text' }
  | { readonly kind: 'json' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'image' }
  | { readonly kind: 'download' }
  | { readonly kind: 'html'; readonly url: string };

const RASTER_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

const SOURCE_MEDIA_TYPES = new Set([
  'application/javascript',
  'application/typescript',
  'application/xml',
  'application/x-httpd-php',
  'application/x-sh',
]);

export function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function supportsSourceView(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  return (
    normalized === 'image/svg+xml' ||
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    SOURCE_MEDIA_TYPES.has(normalized) ||
    (normalized.startsWith('text/') && normalized !== 'text/event-stream')
  );
}

function rendererEndpoint(value: string | undefined): { url: string } | null {
  if (value === undefined || value.trim().length === 0) return null;

  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.username || url.password || url.search || url.hash) return null;
    if (
      url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    )
      return null;
    return { url: new URL('/render', url.origin).href };
  } catch {
    return null;
  }
}

// Route loaders call this once the content kind is known so the matching
// lazy renderer chunk downloads in parallel with the content bytes.
export function prefetchRendererModules(revision: {
  readonly kind: 'file' | 'folder';
  readonly mediaType?: string;
}): void {
  if (revision.kind === 'folder') {
    void import('./components/folder-browser.js');
    return;
  }
  if (
    revision.mediaType !== undefined &&
    selectRenderer(revision.mediaType, undefined).kind === 'markdown'
  ) {
    void import('./components/markdown-view.js');
  }
}

export function selectRenderer(
  mediaType: string,
  rendererOrigin: string | undefined,
): PassiveRenderer {
  const normalized = normalizeMediaType(mediaType);

  if (normalized === 'text/html') {
    const endpoint = rendererEndpoint(rendererOrigin);
    return endpoint === null ? { kind: 'download' } : { kind: 'html', ...endpoint };
  }
  if (normalized === 'text/markdown' || normalized === 'text/x-markdown') {
    return { kind: 'markdown' };
  }
  if (normalized === 'application/json' || normalized.endsWith('+json')) {
    return { kind: 'json' };
  }
  if (RASTER_MEDIA_TYPES.has(normalized)) return { kind: 'image' };
  if (normalized.startsWith('text/') && normalized !== 'text/event-stream') return { kind: 'text' };
  if (SOURCE_MEDIA_TYPES.has(normalized)) return { kind: 'text' };
  return { kind: 'download' };
}
