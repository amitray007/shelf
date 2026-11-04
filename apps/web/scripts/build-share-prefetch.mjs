// Build the share prefetch script as its own tiny bundle. The share document loads it ahead of
// the main bundle so the first share request leaves while the main bundle is still downloading.
// A shared Vite chunk would pull in the whole app graph, which is why this is a separate build.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const temporary = 'assets/share-prefetch.tmp.js';

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    outDir: dist,
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: join(root, 'src/share-prefetch.ts'),
      formats: ['es'],
      fileName: () => temporary,
    },
  },
});

const contents = await readFile(join(dist, temporary));
const file = `assets/share-prefetch-${createHash('sha256').update(contents).digest('base64url').slice(0, 8)}.js`;
await rename(join(dist, temporary), join(dist, file));
await mkdir(join(dist, '.vite'), { recursive: true });
await writeFile(join(dist, '.vite/share-prefetch.json'), `${JSON.stringify({ file })}\n`);
console.log(`share prefetch: ${file} (${contents.byteLength} bytes)`);
