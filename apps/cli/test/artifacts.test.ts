import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const revision = {
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  revisionNumber: 2,
  originalFileName: 'CHANGELOG.md',
  mediaType: 'text/markdown',
  contentHash: `sha256:${'b'.repeat(64)}`,
  byteCount: 24,
  createdAt: '2026-08-17T12:01:00.000Z',
  provenance: {
    classification: 'direct-publish',
    observed: { actorId: 'actor-publisher', operation: 'file.publish' },
  },
  publisherMetadata: { source: 'agent' },
  paths: {
    revision: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB',
    content: '/api/v1/revisions/rev_BBBBBBBBBBBBBBBBBBBBBB/content',
  },
};

const artifact = {
  apiVersion: 'v1',
  workspaceId: 'workspace-main',
  artifactId: 'art_AAAAAAAAAAAAAAAAAAAAAA',
  createdAt: '2026-08-17T12:00:00.000Z',
  updatedAt: '2026-08-17T12:01:00.000Z',
  latestRevision: revision,
  paths: {
    artifact: '/api/v1/artifacts/art_AAAAAAAAAAAAAAAAAAAAAA',
    revisions: '/api/v1/artifacts/art_AAAAAAAAAAAAAAAAAAAAAA/revisions',
  },
};

function capture() {
  let value = '';
  return { write: (chunk: string) => (value += chunk), value: () => value };
}

describe('shelf artifacts', () => {
  it('lists a bounded workspace page as one canonical JSON document', async () => {
    const page = { apiVersion: 'v1', items: [artifact], nextCursor: 'next-page' };
    const stdout = capture();
    const stderr = capture();
    const fetch = vi.fn(async () => Response.json(page));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'list',
        '--url',
        'https://shelf.example',
        '--workspace',
        'workspace-main',
        '--limit',
        '10',
        '--cursor',
        'current-page',
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr: stderr.write,
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(page);
    expect(stderr.value()).toBe('');
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      'https://shelf.example/api/v1/workspaces/workspace-main/artifacts?limit=10&cursor=current-page',
    );
  });

  it('shows one artifact through the shelf command', async () => {
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(artifact));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'show',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(artifact);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}`,
    );
  });

  it('pages one artifact history through the shelf command', async () => {
    const page = {
      apiVersion: 'v1',
      artifactId: artifact.artifactId,
      workspaceId: artifact.workspaceId,
      items: [revision],
      nextCursor: null,
    };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(page));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'history',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--limit',
        '5',
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(page);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}/revisions?limit=5`,
    );
  });
});
