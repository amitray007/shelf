// Builds the standalone CLI distribution (Homebrew tarballs).
// The JavaScript bundle is platform-neutral: workspace dependencies
// (@shelf/contracts) and commander are inlined, and the optional native
// keyring stays external. Each platform directory then vendors the keyring
// loader plus exactly one prebuilt binary, so a user downloads only their
// platform's payload: Keychain on macOS, Secret Service on Linux, and the
// CLI's graceful refusal toward --credential-env where no secret service
// exists.
//
// Usage: node scripts/bundle.mjs <version> [outDir]
// Output: <outDir>/<target>/{dist,node_modules,package.json} per target.
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

export const KEYRING_PLATFORM_TARGETS = [
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

const cliPackage = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
const keyringVersion = cliPackage.optionalDependencies?.['@napi-rs/keyring'];
if (typeof keyringVersion !== 'string') {
  console.error('The @napi-rs/keyring optional dependency is missing from apps/cli.');
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
const shared = join(outDir, '.shared');
await mkdir(join(shared, 'dist'), { recursive: true });
await build({
  entryPoints: [join(cliRoot, 'src/index.ts')],
  outfile: join(shared, 'dist/shelf.js'),
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
  join(shared, 'package.json'),
  `${JSON.stringify({ name: 'shelf-cli', version, type: 'module', bin: { shelf: './dist/shelf.js' } }, null, 2)}\n`,
);

// Fetch the loader and every platform binary once into a vendor cache, then
// copy the loader plus exactly one binary into each platform directory.
// --force lets npm install packages whose os/cpu differ from the build host;
// --ignore-scripts keeps the install inert (napi prebuilds have no scripts).
const vendor = join(outDir, '.vendor');
await mkdir(vendor, { recursive: true });
await promisify(execFile)(
  'npm',
  [
    'install',
    '--prefix',
    vendor,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--force',
    `@napi-rs/keyring@${keyringVersion}`,
    ...KEYRING_PLATFORM_TARGETS.map((target) => `@napi-rs/keyring-${target}@${keyringVersion}`),
  ],
  { env: { ...process.env, npm_config_lockfile: 'false' } },
);

for (const target of KEYRING_PLATFORM_TARGETS) {
  const targetDir = join(outDir, target);
  await cp(join(shared, 'dist'), join(targetDir, 'dist'), { recursive: true });
  await cp(join(shared, 'package.json'), join(targetDir, 'package.json'));
  await cp(
    join(vendor, 'node_modules/@napi-rs/keyring'),
    join(targetDir, 'node_modules/@napi-rs/keyring'),
    { recursive: true },
  );
  await cp(
    join(vendor, `node_modules/@napi-rs/keyring-${target}`),
    join(targetDir, `node_modules/@napi-rs/keyring-${target}`),
    { recursive: true },
  );
}
await rm(shared, { recursive: true, force: true });
await rm(vendor, { recursive: true, force: true });

console.log(
  `bundled shelf CLI ${version} into ${outDir} (${KEYRING_PLATFORM_TARGETS.length} platform directories, keyring ${keyringVersion})`,
);
