// Bundles the CLI into a single standalone module for distribution (Homebrew
// tarball). Workspace dependencies (@shelf/contracts) and commander are
// inlined; the optional native keyring stays external, so a distribution
// without it degrades to --credential-env profiles exactly like a repository
// build with the optional dependency absent.
//
// Usage: node scripts/bundle.mjs <version> [outDir]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
console.log(`bundled shelf CLI ${version} into ${outDir}`);
