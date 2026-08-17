const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DENIED_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'ambient-light-sensor=()',
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
    // Chromium currently does not enforce navigate-to. Keep it as defense in depth while the
    // parent also terminates every navigation after the artifact's first completed load.
    "navigate-to 'none'",
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
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
  ].join('; ');
}
