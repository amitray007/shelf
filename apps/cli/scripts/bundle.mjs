// Bundles the CLI into a standalone distribution (Homebrew tarball).
// Workspace dependencies (@shelf/contracts) and commander are inlined; the
// optional native keyring stays external to the bundle but its loader and
// prebuilt platform binaries are vendored into node_modules/ beside it, so
// --store-token-from-env works from a brew or tarball install on macOS
// (Keychain) and Linux (Secret Service). Platforms without a secret service
// keep the CLI's graceful refusal toward --credential-env.
//
// Usage: node scripts/bundle.mjs <version> [outDir]
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const KEYRING_PLATFORM_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
];

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  console.error('Usage: node scripts/bundle.mjs <semver-version> [outDir]');
  process.exit(2);
}
const cliRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = process.argv[3] ?? join(cliRoot, 'dist-standalone');

await mkdir(join(outDir, 'dist'), { recursive: true });
await build({
  entryPoints: [join(cliRoot, 'src/index.ts')],
  outfile: join(outDir, 'dist/shelf.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['@napi-rs/keyring'],
  define: { __SHELF_CLI_VERSION__: JSON.stringify(version) },
  banner: {
    // esbuild's CJS-interop helpers need require() available under ESM.
    js: "import { createRequire as __shelfCreateRequire } from 'node:module';\nconst require = __shelfCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

await writeFile(
  join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'shelf-cli', version, type: 'module', bin: { shelf: './dist/shelf.js' } }, null, 2)}\n`,
);

// Vendor the keyring loader plus every supported platform binary so one
// platform-neutral tarball serves macOS and Linux alike. --force lets npm
// install packages whose os/cpu differ from the build host; --ignore-scripts
// keeps the install inert (napi prebuilds ship without install scripts).
const cliPackage = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
const keyringVersion = cliPackage.optionalDependencies?.['@napi-rs/keyring'];
if (typeof keyringVersion !== 'string') {
  console.error('The @napi-rs/keyring optional dependency is missing from apps/cli.');
  process.exit(1);
}
const keyringPackages = [
  `@napi-rs/keyring@${keyringVersion}`,
  ...KEYRING_PLATFORM_TARGETS.map((target) => `@napi-rs/keyring-${target}@${keyringVersion}`),
];
await promisify(execFile)(
  'npm',
  [
    'install',
    '--prefix',
    outDir,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--force',
    ...keyringPackages,
  ],
  { env: { ...process.env, npm_config_lockfile: 'false' } },
);
await rm(join(outDir, 'package-lock.json'), { force: true });

console.log(
  `bundled shelf CLI ${version} into ${outDir} (keyring ${keyringVersion}, ${KEYRING_PLATFORM_TARGETS.length} platforms)`,
);
