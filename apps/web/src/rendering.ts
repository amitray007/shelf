export type PassiveRenderer =
  | { readonly kind: 'text' }
  | { readonly kind: 'json' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'table'; readonly format: 'csv' | 'tsv' }
  | { readonly kind: 'image' }
  | { readonly kind: 'pdf' }
  | { readonly kind: 'audio' }
  | { readonly kind: 'video' }
  | { readonly kind: 'docx' }
  | { readonly kind: 'workbook' }
  | { readonly kind: 'download' }
  | { readonly kind: 'html'; readonly url: string };

const RASTER_MEDIA_TYPES = new Set([
  'image/apng',
  'image/bmp',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/avif',
  'image/tiff',
]);

const SOURCE_MEDIA_TYPES = new Set([
  'application/javascript',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-shellscript',
  'application/toml',
  'application/xml',
]);

const SOURCE_FIRST_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsonl',
  '.jsx',
  '.kt',
  '.less',
  '.lua',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
]);

const SOURCE_FIRST_FILENAMES = new Set([
  'caddyfile',
  'dockerfile',
  'gemfile',
  'jenkinsfile',
  'makefile',
  'procfile',
  'rakefile',
]);

const GENERIC_MEDIA_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/binary',
  'application/x-binary',
  'binary/octet-stream',
]);

const EXTENSION_KINDS: ReadonlyMap<string, PassiveRenderer['kind']> = new Map([
  ['.png', 'image'],
  ['.apng', 'image'],
  ['.bmp', 'image'],
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.ico', 'image'],
  ['.tif', 'image'],
  ['.tiff', 'image'],
  ['.gif', 'image'],
  ['.webp', 'image'],
  ['.avif', 'image'],
  ['.svg', 'image'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdown', 'markdown'],
  ['.mkd', 'markdown'],
  ['.txt', 'text'],
  ['.log', 'text'],
  ['.js', 'text'],
  ['.jsx', 'text'],
  ['.mjs', 'text'],
  ['.cjs', 'text'],
  ['.ts', 'text'],
  ['.tsx', 'text'],
  ['.css', 'text'],
  ['.scss', 'text'],
  ['.less', 'text'],
  ['.html', 'text'],
  ['.htm', 'text'],
  ['.xml', 'text'],
  ['.toml', 'text'],
  ['.ini', 'text'],
  ['.conf', 'text'],
  ['.sh', 'text'],
  ['.bash', 'text'],
  ['.py', 'text'],
  ['.rb', 'text'],
  ['.go', 'text'],
  ['.rs', 'text'],
  ['.java', 'text'],
  ['.kt', 'text'],
  ['.json', 'json'],
  ['.jsonl', 'text'],
  ['.geojson', 'json'],
  ['.yaml', 'json'],
  ['.yml', 'json'],
  ['.csv', 'table'],
  ['.tsv', 'table'],
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'workbook'],
  ['.mp3', 'audio'],
  ['.wav', 'audio'],
  ['.wave', 'audio'],
  ['.ogg', 'audio'],
  ['.oga', 'audio'],
  ['.opus', 'audio'],
  ['.flac', 'audio'],
  ['.m4a', 'audio'],
  ['.aac', 'audio'],
  ['.weba', 'audio'],
  ['.mp4', 'video'],
  ['.webm', 'video'],
  ['.ogv', 'video'],
  ['.m4v', 'video'],
  ['.mov', 'video'],
]);

const AUDIO_MEDIA_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/wave',
  'audio/webm',
  'audio/x-wav',
]);

const VIDEO_MEDIA_TYPES = new Set(['video/mp4', 'video/ogg', 'video/webm', 'video/quicktime']);

export function normalizeMediaType(mediaType: string | undefined): string {
  return mediaType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function fileExtension(fileName: string | undefined): string {
  if (fileName === undefined) return '';
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? '' : leaf.slice(dot).toLowerCase();
}

export function prefersSourceView(mediaType: string | undefined, fileName?: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  const leaf = fileName?.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return (
    normalized === 'application/x-ndjson' ||
    normalized === 'application/jsonl' ||
    normalized === 'application/javascript' ||
    normalized === 'application/typescript' ||
    normalized === 'application/x-httpd-php' ||
    normalized === 'application/x-sh' ||
    normalized === 'application/x-shellscript' ||
    SOURCE_FIRST_FILENAMES.has(leaf) ||
    SOURCE_FIRST_EXTENSIONS.has(fileExtension(fileName))
  );
}

function extensionKind(fileName: string | undefined): PassiveRenderer['kind'] | undefined {
  if (fileName === undefined) return undefined;
  const leaf = fileName.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (
    leaf === 'dockerfile' ||
    leaf === 'makefile' ||
    leaf === 'jenkinsfile' ||
    leaf === 'procfile' ||
    leaf === 'caddyfile' ||
    leaf === 'gemfile' ||
    leaf === 'rakefile' ||
    leaf === '.env' ||
    leaf.startsWith('.env.')
  ) {
    return 'text';
  }
  return EXTENSION_KINDS.get(fileExtension(fileName));
}

function isGenericMediaType(mediaType: string): boolean {
  return GENERIC_MEDIA_TYPES.has(mediaType);
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

export function supportsSourceView(mediaType: string | undefined, fileName?: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  if (
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/x-ndjson' ||
    normalized === 'application/jsonl' ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'text/yaml' ||
    normalized === 'text/x-yaml' ||
    normalized === 'text/csv' ||
    normalized === 'text/tab-separated-values' ||
    SOURCE_MEDIA_TYPES.has(normalized) ||
    (normalized.startsWith('text/') && normalized !== 'text/event-stream') ||
    normalized === 'image/svg+xml'
  ) {
    return true;
  }
  const fallback = isGenericMediaType(normalized) ? extensionKind(fileName) : undefined;
  return (
    fallback === 'json' || fallback === 'table' || fallback === 'markdown' || fallback === 'text'
  );
}

export function requiresClientBytes(renderer: PassiveRenderer): boolean {
  return (
    renderer.kind === 'text' ||
    renderer.kind === 'json' ||
    renderer.kind === 'markdown' ||
    renderer.kind === 'table' ||
    renderer.kind === 'docx' ||
    renderer.kind === 'workbook'
  );
}

export function usesPreviewUrl(renderer: PassiveRenderer): boolean {
  return (
    renderer.kind === 'image' ||
    renderer.kind === 'pdf' ||
    renderer.kind === 'audio' ||
    renderer.kind === 'video'
  );
}

// Route loaders call this once the content kind is known so the matching
// lazy renderer chunk downloads in parallel with the content bytes.
export function prefetchRendererModules(revision: {
  readonly kind: 'file' | 'folder';
  readonly mediaType?: string;
  readonly originalFileName?: string;
}): void {
  if (revision.kind === 'folder') {
    void import('./components/folder-browser.js');
    return;
  }
  const renderer = selectRenderer(revision.mediaType, undefined, revision.originalFileName);
  if (renderer.kind === 'markdown') void import('./components/markdown-view.js');
  if (renderer.kind === 'table') void import('./components/preview/delimited-table-preview.js');
  if (renderer.kind === 'json') void import('./components/preview/structured-data-preview.js');
  if (renderer.kind === 'pdf') void import('./components/preview/pdf-viewer.js');
  if (renderer.kind === 'audio' || renderer.kind === 'video') {
    void import('./components/preview/media-preview.js');
  }
  if (renderer.kind === 'docx') {
    void import('./components/preview/office-document-preview.js');
    void import('./components/preview/office-parser-bindings.js');
  }
  if (renderer.kind === 'workbook') {
    void import('./components/preview/workbook-preview.js');
    void import('./components/preview/office-parser-bindings.js');
  }
}

export function selectRenderer(
  mediaType: string | undefined,
  rendererOrigin: string | undefined,
  fileName?: string,
): PassiveRenderer {
  const normalized = normalizeMediaType(mediaType);
  const extension = fileExtension(fileName);
  const fallback = isGenericMediaType(normalized) ? extensionKind(fileName) : undefined;

  if (
    normalized === 'text/html' ||
    (fallback === 'text' && (extension === '.html' || extension === '.htm'))
  ) {
    const endpoint = rendererEndpoint(rendererOrigin);
    return endpoint === null ? { kind: 'download' } : { kind: 'html', ...endpoint };
  }
  if (
    normalized === 'text/markdown' ||
    normalized === 'text/x-markdown' ||
    fallback === 'markdown'
  ) {
    return { kind: 'markdown' };
  }
  if (
    normalized === 'application/json' ||
    normalized.endsWith('+json') ||
    normalized === 'application/yaml' ||
    normalized === 'application/x-yaml' ||
    normalized === 'text/yaml' ||
    normalized === 'text/x-yaml' ||
    fallback === 'json'
  ) {
    return { kind: 'json' };
  }
  if (normalized === 'text/csv' || fallback === 'table') {
    return {
      kind: 'table',
      format:
        normalized === 'text/tab-separated-values' ||
        (isGenericMediaType(normalized) && extension === '.tsv')
          ? 'tsv'
          : 'csv',
    };
  }
  if (normalized === 'text/tab-separated-values') return { kind: 'table', format: 'tsv' };
  if (
    RASTER_MEDIA_TYPES.has(normalized) ||
    normalized === 'image/svg+xml' ||
    fallback === 'image'
  ) {
    return { kind: 'image' };
  }
  if (normalized === 'application/pdf' || fallback === 'pdf') return { kind: 'pdf' };
  if (
    normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fallback === 'docx'
  )
    return { kind: 'docx' };
  if (
    normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    fallback === 'workbook'
  )
    return { kind: 'workbook' };
  if (
    AUDIO_MEDIA_TYPES.has(normalized) ||
    (normalized.startsWith('audio/') && !normalized.includes('mpegurl')) ||
    fallback === 'audio'
  ) {
    return { kind: 'audio' };
  }
  if (
    VIDEO_MEDIA_TYPES.has(normalized) ||
    (normalized.startsWith('video/') && !normalized.includes('mpegurl')) ||
    fallback === 'video'
  ) {
    return { kind: 'video' };
  }
  if (
    normalized === 'application/x-ndjson' ||
    normalized === 'application/jsonl' ||
    fallback === 'text' ||
    (normalized.startsWith('text/') && normalized !== 'text/event-stream')
  )
    return { kind: 'text' };
  if (SOURCE_MEDIA_TYPES.has(normalized)) return { kind: 'text' };
  return { kind: 'download' };
}
