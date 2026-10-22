import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const suffix = process.argv.includes('--baseline') ? '.baseline' : '';
const { prepareLocalFolder } = await import(`../apps/cli/dist/commands/folders${suffix}.js`);
const { createFolderEntryContentService } = await import(
  `../packages/core/dist/folders/tree${suffix}.js`
);
const { canonicalFolderManifest, validateFolderManifestInput } = await import(
  `../packages/core/dist/folders/snapshot${suffix}.js`
);

// Run after pnpm build: node scripts/benchmark-folders.mjs
// Timings exclude fixture creation. Entry lookup uses an in-memory repository,
// including per-row materialization, without database or network latency.
// To compare in one checkout, save these compiled modules as *.baseline.js
// before editing, then run again with --baseline. Saved modules stay in ignored dist/.
const sampleArgument = process.argv.find((value) => value.startsWith('--samples='));
const samples =
  sampleArgument === undefined ? 9 : Number(sampleArgument.slice('--samples='.length));
assert(Number.isInteger(samples) && samples > 0, '--samples must be a positive integer');
const iterations = 1_000;

async function measure(run) {
  await run();
  const times = [];
  const cpuTimes = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
    const cpu = process.cpuUsage(cpuStart);
    cpuTimes.push((cpu.user + cpu.system) / 1_000);
  }
  times.sort((left, right) => left - right);
  cpuTimes.sort((left, right) => left - right);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    medianCpuMs: cpuTimes[Math.floor(cpuTimes.length / 2)],
    minMs: times[0],
    maxMs: times.at(-1),
  };
}

function cloneEntry(entry) {
  return entry.kind === 'file' ? { ...entry, content: { ...entry.content } } : { ...entry };
}

async function lookup(entryCount) {
  const entries = Array.from({ length: entryCount / 2 }, (_, index) => {
    const path = `dir-${String(index).padStart(4, '0')}`;
    return [
      { path, kind: 'directory' },
      {
        path: `${path}/file.txt`,
        kind: 'file',
        mediaType: 'text/plain',
        content: {
          contentId: `content-${index}`,
          contentHash: `sha256:${'a'.repeat(64)}`,
          byteCount: 1,
        },
      },
    ];
  }).flat();
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const request = { installationId: 'synthetic', actorId: 'reader', revisionId: 'revision' };
  let rows = 0;
  const readEntry = createFolderEntryContentService({
    authorizer: { async authorize() {} },
    contentReader: {
      async read() {
        throw new Error('Benchmark must not read content');
      },
    },
    folders: {
      async findFolderRevision() {
        return { ...request, workspaceId: 'workspace' };
      },
      async listFolderEntries() {
        rows += entries.length;
        return { items: entries.map(cloneEntry) };
      },
      async findFolderEntry({ path }) {
        const entry = byPath.get(path);
        if (entry === undefined) return undefined;
        rows += 1;
        return cloneEntry(entry);
      },
    },
  });
  const timing = await measure(async () => {
    for (let index = 0; index < iterations; index += 1) {
      const path = entries[(index % (entryCount / 2)) * 2 + 1].path;
      const result = await readEntry({ ...request, path });
      assert.equal(result.path, path);
      assert.equal(result.byteCount, 1);
    }
  });
  return {
    workload: 'entry-lookup',
    entryCount,
    iterations,
    ...timing,
    rowsPerLookup: rows / ((samples + 1) * iterations),
  };
}

async function enumeration(parent, files, bytesPerFile, nested, nonemptyFiles = files) {
  const directory = join(parent, `site-${files}-${bytesPerFile}-${nested}`);
  await mkdir(directory);
  const bytes = Buffer.alloc(bytesPerFile, 97);
  for (let index = 0; index < files; index += 1) {
    const name = `file-${String(index).padStart(4, '0')}`;
    const target = nested ? join(directory, name) : directory;
    if (nested) await mkdir(target);
    await writeFile(join(target, `${name}.txt`), index < nonemptyFiles ? bytes : new Uint8Array());
  }
  let fingerprint;
  const allocations = process.argv.includes('--allocations');
  const allocate = Buffer.allocUnsafeSlow;
  let allocatedBytes = 0;
  let allocatedBuffers = 0;
  try {
    // Count requested allocation bytes, not peak memory. Fixture creation is excluded.
    if (allocations) {
      Buffer.allocUnsafeSlow = (size) => {
        allocatedBytes += size;
        allocatedBuffers += 1;
        return allocate(size);
      };
    }
    const timing = await measure(async () => {
      const prepared = await prepareLocalFolder(directory);
      assert.equal(prepared.files.length, files);
      assert.equal(prepared.manifest.entries.length, files * (nested ? 2 : 1));
      fingerprint ??= prepared.contentFingerprint;
      assert.equal(prepared.contentFingerprint, fingerprint);
    });
    return {
      workload: 'enumerate-and-fingerprint',
      files,
      bytesPerFile,
      nested,
      totalBytes: nonemptyFiles * bytesPerFile,
      nonemptyFiles,
      fingerprint,
      ...timing,
      ...(allocations
        ? {
            allocatedBytesPerRun: allocatedBytes / (samples + 1),
            allocatedBuffersPerRun: allocatedBuffers / (samples + 1),
          }
        : {}),
    };
  } finally {
    Buffer.allocUnsafeSlow = allocate;
  }
}

async function validation(depth) {
  const segments = Array.from({ length: depth - 1 }, (_, index) => `d${index}`);
  const directories = segments.map((_, index) => ({
    path: segments.slice(0, index + 1).join('/'),
    kind: 'directory',
  }));
  const prefix = segments.length === 0 ? '' : `${segments.join('/')}/`;
  const entries = [
    ...directories,
    ...Array.from({ length: 1_000 }, (_, index) => ({
      path: `${prefix}f${index}`,
      kind: 'file',
      mediaType: 'text/plain',
    })),
  ];
  const input = { version: 'shelf-folder-manifest/v1', rootName: 'deep', entries };
  assert.deepEqual(validateFolderManifestInput(input), input);
  const timing = await measure(() => {
    for (let index = 0; index < 5; index += 1) validateFolderManifestInput(input);
  });
  return {
    workload: 'validate-manifest',
    depth,
    entryCount: entries.length,
    iterations: 5,
    ...timing,
  };
}

async function manifest() {
  const entries = Array.from({ length: 1_000 }, (_, index) => {
    const id = (index * 719) % 1_000;
    const path = `dir-${id}-café-📦`;
    return [
      { path, kind: 'directory' },
      {
        path: `${path}/file.txt`,
        kind: 'file',
        mediaType: 'text/plain',
        content: {
          contentId: `content-${id}`,
          contentHash: `sha256:${'a'.repeat(64)}`,
          byteCount: 1,
        },
      },
    ];
  }).flat();
  let contentHash;
  const timing = await measure(() => {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const result = canonicalFolderManifest(entries);
      contentHash ??= result.contentHash;
      assert.equal(result.contentHash, contentHash);
      assert.equal(result.fileCount, 1_000);
      assert.equal(result.byteCount, 1_000);
    }
  });
  return {
    workload: 'canonical-manifest',
    entryCount: entries.length,
    iterations: 50,
    contentHash,
    ...timing,
  };
}

async function rendererBenchmarks() {
  const { createCoreHtmlResolver } = await import(`../apps/renderer/dist/resolver${suffix}.js`);
  const { rewritePublicPreviewReferences } = await import('../apps/renderer/dist/folder-assets.js');
  const { rendererFolderDependencies, rendererStoredShare, rendererIds } = await import(
    '../apps/renderer/test/support/renderer-dependencies.ts'
  );
  const authority = { type: 'public', publicCode: rendererIds.publicCode };
  for (const size of [1024 * 1024, 10 * 1024 * 1024]) {
    const bytes = new TextEncoder().encode(`<p>Synthetic</p>${'x'.repeat(size - 16)}`);
    const dependencies = rendererFolderDependencies(
      {
        'index.html': { mediaType: 'text/html', content: bytes },
        'image.png': { mediaType: 'image/png', content: new Uint8Array(size) },
      },
      { share: rendererStoredShare({ accessType: 'public', publicCode: rendererIds.publicCode }) },
    );
    const counts = { shareLookups: 0, entryLookups: 0, contentReads: 0, contentBytes: 0 };
    const resolve = dependencies.shares.resolvePublicShareTarget.bind(dependencies.shares);
    dependencies.shares.resolvePublicShareTarget = (...args) => {
      counts.shareLookups += 1;
      return resolve(...args);
    };
    const find = dependencies.folders.findFolderEntry.bind(dependencies.folders);
    dependencies.folders.findFolderEntry = (...args) => {
      counts.entryLookups += 1;
      return find(...args);
    };
    const read = dependencies.contentReader.read.bind(dependencies.contentReader);
    dependencies.contentReader.read = async (...args) => {
      counts.contentReads += 1;
      const source = await read(...args);
      return (async function* () {
        for await (const chunk of source) {
          counts.contentBytes += chunk.byteLength;
          yield chunk;
        }
      })();
    };
    const resolver = createCoreHtmlResolver({
      ...dependencies,
      viewerSessionTokenCodec: {
        verify() {
          return undefined;
        },
      },
    });
    for (const workload of ['folder-html-resolution', 'folder-html-read', 'folder-image-range']) {
      for (const key of Object.keys(counts)) counts[key] = 0;
      const timing = await measure(async () => {
        if (workload === 'folder-html-resolution') {
          const result = await resolver.resolveHtml({
            accessType: 'public',
            publicCode: authority.publicCode,
            path: 'index.html',
          });
          assert.equal(result.status, 'folder');
        } else {
          const result = await resolver.readFolderFile({
            authority,
            revisionId: rendererIds.revision,
            path: workload === 'folder-html-read' ? 'index.html' : 'image.png',
          });
          if (workload === 'folder-html-read') {
            assert.equal(result.kind, 'html');
            assert.equal(result.html.length, bytes.length);
          } else {
            assert.equal(result.kind, 'file');
            let delivered = 0;
            for await (const chunk of await result.read({ start: 0, end: 65_535 }))
              delivered += chunk.byteLength;
            assert.equal(delivered, 65_536);
          }
        }
      });
      console.log(
        JSON.stringify({
          workload,
          size,
          ...timing,
          perRequest: Object.fromEntries(
            Object.entries(counts).map(([key, value]) => [key, value / (samples + 1)]),
          ),
        }),
      );
    }
  }
  const prefix = `/api/v1/public/links/${authority.publicCode}/tree/content/preview`;
  const references = Array.from({ length: 100 }, () => `<img src="${prefix}?path=image.png">`).join(
    '',
  );
  const html = `<!doctype html><body>${references}${'x'.repeat(1024 * 1024 - references.length - 21)}`;
  const timing = await measure(() => {
    const result = rewritePublicPreviewReferences({
      html,
      appOrigin: 'https://shelf.example',
      publicCode: authority.publicCode,
      sessionPath: '/f/synthetic.signature/',
    });
    assert(result.includes('src="/f/synthetic.signature/image.png"'));
    assert(!result.includes(prefix));
  });
  console.log(
    JSON.stringify({
      workload: 'legacy-public-reference-rewrite',
      size: Buffer.byteLength(html),
      references: 100,
      ...timing,
    }),
  );
}

await mkdir(new URL('../node_modules/.cache/', import.meta.url), { recursive: true });
const parent = await mkdtemp(
  fileURLToPath(new URL('../node_modules/.cache/shelf-perf-', import.meta.url)),
);
try {
  console.log(
    JSON.stringify({
      node: process.version,
      samples,
      warmups: 1,
      repository: 'synthetic in-memory; no database latency',
    }),
  );
  if (
    !process.argv.includes('--enumeration-only') &&
    !process.argv.includes('--manifest-only') &&
    !process.argv.includes('--validation-only') &&
    !process.argv.includes('--renderer-only')
  ) {
    for (const entryCount of [20, 200, 2_000])
      console.log(JSON.stringify(await lookup(entryCount)));
  }
  if (
    !process.argv.includes('--lookup-only') &&
    !process.argv.includes('--enumeration-only') &&
    !process.argv.includes('--validation-only') &&
    !process.argv.includes('--renderer-only')
  ) {
    console.log(JSON.stringify(await manifest()));
  }
  if (
    !process.argv.includes('--lookup-only') &&
    !process.argv.includes('--manifest-only') &&
    !process.argv.includes('--validation-only') &&
    !process.argv.includes('--renderer-only')
  ) {
    for (const [files, bytes, nested, nonemptyFiles] of [
      [1_000, 1_024, false],
      [1_000, 1_024, true],
      [10, 10 * 1024 * 1024, false],
      [1_000, 10 * 1024 * 1024, true, 10],
    ]) {
      console.log(JSON.stringify(await enumeration(parent, files, bytes, nested, nonemptyFiles)));
    }
  }
  if (
    process.argv.includes('--validation-only') ||
    !process.argv.some((value) => value.endsWith('-only'))
  ) {
    for (const depth of [1, 16, 64]) console.log(JSON.stringify(await validation(depth)));
  }
  if (
    process.argv.includes('--renderer-only') ||
    !process.argv.some((value) => value.endsWith('-only'))
  ) {
    await rendererBenchmarks();
  }
} finally {
  await rm(parent, { recursive: true, force: true });
}
