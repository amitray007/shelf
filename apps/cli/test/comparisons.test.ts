import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

describe('shelf revisions compare', () => {
  it('returns canonical JSON from the public comparison contract', async () => {
    const baseRevisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';
    const targetRevisionId = 'rev_BBBBBBBBBBBBBBBBBBBBBB';
    const result = {
      apiVersion: 'v1',
      kind: 'file',
      workspaceId: 'workspace-main',
      artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
      base: {
        revisionId: baseRevisionId,
        contentHash: `sha256:${'a'.repeat(64)}`,
        byteCount: 4,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      target: {
        revisionId: targetRevisionId,
        contentHash: `sha256:${'b'.repeat(64)}`,
        byteCount: 5,
        originalFileName: 'README.md',
        mediaType: 'text/markdown',
      },
      status: 'changed',
      changes: { content: true, mediaType: false, originalFileName: false },
    };
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () => Response.json(result));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'revisions',
        'compare',
        '--url',
        'https://shelf.example',
        '--base',
        baseRevisionId,
        '--target',
        targetRevisionId,
        '--limit',
        '25',
      ],
      { env: { SHELF_TOKEN: 'secret-token' }, stdout: stdout.write, stderr: stderr.write, fetch },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(result);
    expect(stderr.value()).toBe('');
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/revisions/${baseRevisionId}/comparisons/${targetRevisionId}?limit=25`,
    );
  });
});
