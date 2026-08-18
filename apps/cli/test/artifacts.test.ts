import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/index.js';

const revision = {
  kind: 'file',
  revisionId: 'rev_BBBBBBBBBBBBBBBBBBBBBB',
  revisionNumber: 2,
  originalFileName: 'CHANGELOG.md',
  mediaType: 'text/markdown',
  contentHash: `sha256:${'b'.repeat(64)}`,
  byteCount: 24,
  fileCount: 1,
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
  kind: 'file',
  name: 'Release notes',
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
        '--order',
        'oldest',
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
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}/revisions?limit=5&order=oldest`,
    );
  });

  it('renames artifact presentation through the shelf command', async () => {
    const renamed = { ...artifact, name: 'Project notes' };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(renamed));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'rename',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--name',
        'Project notes',
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(renamed);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' });
  });

  it('accepts a 255-character Unicode artifact name', async () => {
    const name = '📚'.repeat(255);
    const renamed = { ...artifact, name };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(renamed));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'rename',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--name',
        name,
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ name }) });
  });

  it('restores an immutable revision through the shelf command', async () => {
    const sourceRevisionId = 'rev_AAAAAAAAAAAAAAAAAAAAAA';
    const result = {
      apiVersion: 'v1',
      kind: 'file',
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
      revisionNumber: 4,
      sourceRevisionId,
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 18,
      fileCount: 1,
      provenance: {
        classification: 'restore',
        observed: { actorId: 'actor-restorer', operation: 'revision.restore' },
        source: { revisionId: sourceRevisionId },
      },
      requestId: 'request-restore',
      paths: {
        artifact: `/api/v1/artifacts/${artifact.artifactId}`,
        revision: '/api/v1/revisions/rev_CCCCCCCCCCCCCCCCCCCCCC',
        content: '/api/v1/revisions/rev_CCCCCCCCCCCCCCCCCCCCCC/content',
      },
      replayed: false,
    };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(result, { status: 201 }));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'restore',
        '--url',
        'https://shelf.example',
        '--workspace',
        artifact.workspaceId,
        '--artifact',
        artifact.artifactId,
        '--revision',
        sourceRevisionId,
        '--idempotency-key',
        'restore-version-one',
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout: stdout.write,
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.value())).toEqual(result);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/workspaces/${artifact.workspaceId}/artifacts/${artifact.artifactId}/restores`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'restore-version-one' }),
      body: JSON.stringify({ sourceRevisionId }),
    });
  });

  it('soft-deletes an artifact through the shelf command', async () => {
    const result = {
      apiVersion: 'v1',
      workspaceId: artifact.workspaceId,
      artifactId: artifact.artifactId,
      deletedAt: '2026-08-18T12:00:00.000Z',
      recoverableUntil: '2026-09-17T12:00:00.000Z',
      revokedShareCount: 2,
    };
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(result));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'delete',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--confirm',
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
    expect(JSON.parse(stdout.value())).toEqual(result);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('refuses artifact deletion when confirmation does not exactly match without fetching', async () => {
    const stderr = capture();
    const fetch = vi.fn();

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'delete',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--confirm',
        'art_BBBBBBBBBBBBBBBBBBBBBB',
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr: stderr.write,
        fetch,
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr.value())).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recovers an artifact through the shelf command', async () => {
    const stdout = capture();
    const fetch = vi.fn(async () => Response.json(artifact));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'recover',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
        '--idempotency-key',
        'recover-readme',
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
      `https://shelf.example/api/v1/artifacts/${artifact.artifactId}/recovery`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'idempotency-key': 'recover-readme' }),
    });
  });

  it('generates one recovery idempotency key when none is supplied', async () => {
    const fetch = vi.fn(async () => Response.json(artifact));

    const exitCode = await runCli(
      [
        'node',
        'shelf',
        'artifacts',
        'recover',
        '--url',
        'https://shelf.example',
        '--artifact',
        artifact.artifactId,
      ],
      {
        env: { SHELF_TOKEN: 'secret-token' },
        stdout() {},
        stderr() {},
        fetch,
      },
    );

    expect(exitCode).toBe(0);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toMatch(
      /^artifact-recover-[0-9a-f-]{36}$/u,
    );
  });
});
