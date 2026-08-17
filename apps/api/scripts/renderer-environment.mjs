const rendererEnvironmentNames = [
  'DATABASE_URL',
  'SHELF_INSTALLATION_ID',
  'SHELF_STORAGE_DRIVER',
  'SHELF_STORAGE_LOCAL_ROOT',
  'SHELF_STORAGE_PREFIX',
  'SHELF_R2_ACCOUNT_ID',
  'SHELF_R2_BUCKET',
  'SHELF_R2_ACCESS_KEY_ID',
  'SHELF_R2_SECRET_ACCESS_KEY',
  'SHELF_R2_SESSION_TOKEN',
  'SHELF_SHARE_SIGNING_KEY',
  'SHELF_SHARE_SIGNING_KEY_FILE',
  'SHELF_RENDERER_APP_ORIGIN',
  'SHELF_RENDERER_HOST',
  'SHELF_RENDERER_PORT',
  'SHELF_RENDERER_MAX_HTML_BYTES',
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_ENV',
];

export function rendererEnvironment(environment) {
  return Object.fromEntries(
    rendererEnvironmentNames.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
