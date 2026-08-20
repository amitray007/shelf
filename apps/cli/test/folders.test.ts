import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareLocalFolder } from '../src/commands/folders.js';
import { runCli } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

async function folderFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'shelf-folder-cli-'));
  roots.push(parent);
  const root = join(parent, 'project');
  await mkdir(join(root, 'empty'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Shelf\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
  return root;
}

const result = {
  apiVersion: 'v1',
  kind: 'folder',
  workspaceId: 'workspace-main',
  artifactId: 'art_0123456789abcdefghijkl',
  revisionId: 'rev_0123456789abcdefghijkl',
  contentHash: `sha256:${'a'.repeat(64)}`,
  byteCount: 19,
  fileCount: 2,
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-agent', operation: 'file.publish' },
  },
  publisherMetadata: { source: 'cli' },
  requestId: 'request-folder',
  paths: {
    artifact: '/api/v1/artifacts/art_0123456789abcdefghijkl',
    revision: '/api/v1/revisions/rev_0123456789abcdefghijkl',
    tree: '/api/v1/revisions/rev_0123456789abcdefghijkl/tree',
  },
  replayed: false,
};

describe('shelf folders', () => {
  it('fingerprints exact folder bytes rather than only paths or sizes', async () => {
    const directory = await folderFixture();
    const first = await prepareLocalFolder(directory);
    await writeFile(join(directory, 'README.md'), '# Other\n');
    const second = await prepareLocalFolder(directory);

    expect(first.contentFingerprint).not.toBe(second.contentFingerprint);
  });

  it('publishes a deterministic manifest before ordered file parts', async () => {
    const directory = await folderFixture();
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'folders',
        'publish',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--directory',
        directory,
        '--idempotency-key',
        'folder-one',
        '--metadata',
        'source=cli',
        '--title',
        'Project snapshot',
        '--description',
        'Complete project tree',
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout: stdout.write, stderr: stderr.write, fetch },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(result);
    expect(stderr.value()).toBe('');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url?.toString()).toBe('https://shelf.example/api/v1/workspaces/workspace-main/folders');
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['publisherMetadata', 'manifest', 'file', 'file']);
    expect(form.get('publisherMetadata')).toBe(
      '{"source":"cli","title":"Project snapshot","description":"Complete project tree"}',
    );
    expect(JSON.parse(String(form.get('manifest')))).toEqual({
      version: 'shelf-folder-manifest/v1',
      rootName: 'project',
      entries: [
        { path: 'README.md', kind: 'file', mediaType: 'text/markdown' },
        { path: 'empty', kind: 'directory' },
        { path: 'src', kind: 'directory' },
        { path: 'src/index.ts', kind: 'file', mediaType: 'text/typescript' },
      ],
    });
    expect(await Promise.all(form.getAll('file').map((file) => (file as Blob).text()))).toEqual([
      '# Shelf\n',
      'export {};\n',
    ]);
    expect(form.getAll('file').map((file) => (file as Blob).type)).toEqual([
      'text/markdown',
      'text/typescript',
    ]);
  });

  it('requires title and description for agent folder publishes and documents the bypass', async () => {
    const directory = await folderFixture();
    const stderr = capture();
    const fetch = vi.fn();
    const base = [
      'node',
      'shelf',
      'folders',
      'publish',
      '--url',
      'https://shelf.example',
      '--workspace',
      'workspace-main',
      '--directory',
      directory,
      '--idempotency-key',
      'folder-metadata',
    ];

    expect(
      await runCli(base, {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr: stderr.write,
        fetch,
      }),
    ).toBe(2);
    expect(stderr.value()).toContain('--title and --description');
    expect(fetch).not.toHaveBeenCalled();

    const stdout = capture();
    expect(
      await runCli(['node', 'shelf', 'folders', 'publish', '--help'], {
        env: {},
        stdout: stdout.write,
        stderr() {},
      }),
    ).toBe(0);
    expect(stdout.value()).toContain('--user-bypass');
    expect(stdout.value()).toContain('Agent publishes require');

    fetch.mockResolvedValueOnce(Response.json(result, { status: 201 }));
    expect(
      await runCli([...base, '--user-bypass'], {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr() {},
        fetch,
      }),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('pages an immutable folder tree', async () => {
    const page = {
      apiVersion: 'v1',
      revisionId: result.revisionId,
      contentHash: result.contentHash,
      byteCount: result.byteCount,
      fileCount: result.fileCount,
      items: [{ path: 'empty', kind: 'directory' }],
      nextCursor: null,
    };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(page));
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'folders',
        'tree',
        '--url',
        'https://shelf.example',
        '--revision',
        result.revisionId,
        '--limit',
        '25',
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout: stdout.write, stderr() {}, fetch },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(page);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/revisions/${result.revisionId}/tree?limit=25`,
    );
  });

  it('downloads one folder entry to an explicit new path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-folder-download-'));
    roots.push(root);
    const output = join(root, 'index.ts');
    const bytes = 'export {};\n';
    const stdout = capture();
    const fetch = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(Buffer.byteLength(bytes)),
            'content-type': 'text/typescript',
            etag: `"sha256:${'c'.repeat(64)}"`,
          },
        }),
    );

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'folders',
        'download',
        '--url',
        'https://shelf.example',
        '--revision',
        result.revisionId,
        '--path',
        'src/index.ts',
        '--output',
        output,
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout: stdout.write, stderr() {}, fetch },
    );

    expect(exitCode).toBe(0);
    expect(await readFile(output, 'utf8')).toBe(bytes);
    expect(JSON.parse(stdout.value())).toEqual({
      apiVersion: 'v1',
      operation: 'folders.download',
      revisionId: result.revisionId,
      path: 'src/index.ts',
      output,
      byteCount: Buffer.byteLength(bytes),
      mediaType: 'text/typescript',
      entityTag: `"sha256:${'c'.repeat(64)}"`,
    });
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/revisions/${result.revisionId}/tree/content?path=src%2Findex.ts`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
    });
  });

  it('refuses to replace a folder entry output without --overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-folder-download-overwrite-'));
    roots.push(root);
    const output = join(root, 'README.md');
    await writeFile(output, 'old bytes');
    const fetch = vi.fn(
      async () =>
        new Response('new bytes', {
          headers: { 'content-length': '9', 'content-type': 'text/markdown' },
        }),
    );
    const args = [
      'node',
      'shelf',
      'folders',
      'download',
      '--url',
      'https://shelf.example',
      '--revision',
      result.revisionId,
      '--path',
      'README.md',
      '--output',
      output,
    ];

    expect(
      await runCli(args, {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr() {},
        fetch,
      }),
    ).toBe(2);
    expect(await readFile(output, 'utf8')).toBe('old bytes');
    expect(fetch).not.toHaveBeenCalled();

    expect(
      await runCli([...args, '--overwrite'], {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr() {},
        fetch,
      }),
    ).toBe(0);
    expect(await readFile(output, 'utf8')).toBe('new bytes');
  });

  it('leaves no folder entry output when streamed bytes do not match the declared length', async () => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-folder-download-truncated-'));
    roots.push(root);
    const output = join(root, 'README.md');
    const stderr = capture();
    const fetch = vi.fn(
      async () =>
        new Response('short', {
          headers: { 'content-length': '9', 'content-type': 'text/markdown' },
        }),
    );

    expect(
      await runCli(
        [
          'node',
          'shelf',
          'folders',
          'download',
          '--url',
          'https://shelf.example',
          '--revision',
          result.revisionId,
          '--path',
          'README.md',
          '--output',
          output,
        ],
        { env: { SHELF_TOKEN: 'secret-token' }, stdout() {}, stderr: stderr.write, fetch },
      ),
    ).toBe(1);
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', 'src/../../secret'],
    ['a backslash path', 'src\\index.ts'],
    ['an empty segment', 'src//index.ts'],
  ] as const)('rejects %s before contacting the API', async (_name, path) => {
    const root = await mkdtemp(join(tmpdir(), 'shelf-folder-download-invalid-'));
    roots.push(root);
    const stderr = capture();
    const fetch = vi.fn();

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'folders',
        'download',
        '--url',
        'https://shelf.example',
        '--revision',
        result.revisionId,
        '--path',
        path,
        '--output',
        join(root, 'out.bin'),
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout() {}, stderr: stderr.write, fetch },
    );

    expect(exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('documents folder entry download safety and required flags', async () => {
    const stdout = capture();
    expect(
      await runCli(['node', 'shelf', 'folders', 'download', '--help'], {
        env: {},
        stdout: stdout.write,
        stderr() {},
      }),
    ).toBe(0);
    expect(stdout.value()).toContain('--path <entry-path>');
    expect(stdout.value()).toContain('--output <path>');
    expect(stdout.value()).toContain('--overwrite');
    expect(stdout.value()).toContain('--profile <name>');
    expect(stdout.value()).toContain('refuses to replace');
  });

  it('rejects symlinks before making a request', async () => {
    const directory = await folderFixture();
    await symlink(join(directory, 'README.md'), join(directory, 'linked.md'));
    const stderr = capture();
    const fetch = vi.fn();
    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'folders',
        'publish',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--directory',
        directory,
        '--idempotency-key',
        'folder-one',
        '--user-bypass',
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout() {}, stderr: stderr.write, fetch },
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
