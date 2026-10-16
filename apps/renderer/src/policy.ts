const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DENIED_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'clipboard-read=()',
  'clipboard-write=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'local-fonts=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'web-share=()',
  'xr-spatial-tracking=()',
].join(', ');

export function validatedAppOrigin(value: string): string {
  const url = new URL(value);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Renderer appOrigin must be an HTTPS origin or an HTTP loopback origin.');
  }
  return url.origin;
}

function commonPolicy(appOrigin: string): string[] {
  return [
    "default-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors ${appOrigin}`,
    'sandbox allow-scripts',
  ];
}

export function bootstrapContentSecurityPolicy(appOrigin: string): string {
  return [...commonPolicy(appOrigin), "script-src 'none'", "style-src 'none'"].join('; ');
}

export function artifactContentSecurityPolicy(appOrigin: string): string {
  return [
    ...commonPolicy(appOrigin),
    "script-src 'unsafe-inline' data:",
    "style-src 'unsafe-inline' blob:",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
  ].join('; ');
}

/**
 * Folder HTML may load sibling files, but only from its own revision-scoped folder session path.
 * External origins, other folder sessions, and renderer routes outside that path stay blocked.
 */
export function folderDocumentContentSecurityPolicy(
  appOrigin: string,
  sessionSource: string,
): string {
  return [
    "default-src 'none'",
    `connect-src ${sessionSource}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    `frame-ancestors ${appOrigin}`,
    'sandbox allow-scripts',
    `script-src 'unsafe-inline' data: ${sessionSource}`,
    `style-src 'unsafe-inline' ${sessionSource}`,
    `img-src data: blob: ${sessionSource}`,
    `font-src data: ${sessionSource}`,
    `media-src data: blob: ${sessionSource}`,
  ].join('; ');
}

/** Sibling file bytes never run as a document, even when opened directly. */
export const FOLDER_FILE_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";
