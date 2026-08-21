// Precompress build output so the API server can serve .br/.gz variants
// via @fastify/static's preCompressed option instead of compressing on the fly.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const distRoot = fileURLToPath(new URL('../dist', import.meta.url));
const compressible = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.map', '.wasm']);
const minBytes = 1024;

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

let files = 0;
let saved = 0;
for await (const path of walk(distRoot)) {
  const extension = path.slice(path.lastIndexOf('.'));
  if (!compressible.has(extension) || path.endsWith('.gz') || path.endsWith('.br')) continue;
  const { size } = await stat(path);
  if (size < minBytes) continue;
  const contents = await readFile(path);
  const brotli = brotliCompressSync(contents, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: contents.byteLength,
    },
  });
  const gzip = gzipSync(contents, { level: 9 });
  if (brotli.byteLength < size) await writeFile(`${path}.br`, brotli);
  if (gzip.byteLength < size) await writeFile(`${path}.gz`, gzip);
  files += 1;
  saved += size - Math.min(brotli.byteLength, gzip.byteLength, size);
}

console.log(
  `precompressed ${files} files, best-variant savings ${(saved / 1024 / 1024).toFixed(1)} MiB`,
);
