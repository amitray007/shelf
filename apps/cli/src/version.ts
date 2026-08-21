// The release bundle replaces __SHELF_CLI_VERSION__ via esbuild define; a
// repository build falls through to the dev marker.
declare const __SHELF_CLI_VERSION__: string | undefined;

export const CLI_VERSION =
  typeof __SHELF_CLI_VERSION__ === 'string' ? __SHELF_CLI_VERSION__ : '0.0.0-dev';
