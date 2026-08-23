import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('CLI wire contract', () => {
  it('is backed by the checked OpenAPI publish operation', async () => {
    const document = JSON.parse(
      await readFile(new URL('../../api/openapi/v1.json', import.meta.url), 'utf8'),
    );
    const operations = [
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts'].post,
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/revisions'].post,
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts'].get,
      document.paths['/api/v1/artifacts/{artifactId}'].patch,
      document.paths['/api/v1/artifacts/{artifactId}'].delete,
      document.paths['/api/v1/artifacts/{artifactId}/recovery'].post,
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/restores'].post,
      document.paths['/api/v1/workspaces/{workspaceId}/folders'].post,
      document.paths['/api/v1/revisions/{revisionId}/tree'].get,
      document.paths['/api/v1/revisions/{baseRevisionId}/comparisons/{targetRevisionId}'].get,
    ];
    for (const operation of operations) {
      expect(operation.security).toContainEqual({ bearerAuth: [] });
    }

    expect(operations[0]).toMatchObject({
      operationId: 'publishFileV1',
      requestBody: {
        content: { 'multipart/form-data': { schema: { required: ['file'] } } },
      },
    });
    expect(
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/revisions'].post,
    ).toMatchObject({ operationId: 'publishArtifactRevisionV1' });
    expect(document.paths['/api/v1/workspaces/{workspaceId}/artifacts'].get).toMatchObject({
      operationId: 'listArtifactsV1',
    });
    expect(document.paths['/api/v1/artifacts/{artifactId}'].get).toMatchObject({
      operationId: 'getArtifactV1',
    });
    expect(document.paths['/api/v1/artifacts/{artifactId}/revisions'].get).toMatchObject({
      operationId: 'listArtifactRevisionsV1',
    });
    expect(document.paths['/api/v1/artifacts/{artifactId}'].patch).toMatchObject({
      operationId: 'renameArtifactV1',
    });
    expect(document.paths['/api/v1/artifacts/{artifactId}'].delete).toMatchObject({
      operationId: 'deleteArtifactV1',
    });
    expect(document.paths['/api/v1/trash/{artifactId}'].delete).toMatchObject({
      operationId: 'permanentlyDeleteArtifactV1',
    });
    expect(document.paths['/api/v1/workspaces/{workspaceId}/trash'].delete).toMatchObject({
      operationId: 'emptyTrashV1',
    });
    expect(document.paths['/api/v1/artifacts/{artifactId}/recovery'].post).toMatchObject({
      operationId: 'recoverArtifactV1',
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
      ]),
      responses: { 200: expect.any(Object), 409: expect.any(Object), 410: expect.any(Object) },
    });
    expect(
      document.paths['/api/v1/workspaces/{workspaceId}/artifacts/{artifactId}/restores'].post,
    ).toMatchObject({
      operationId: 'restoreArtifactRevisionV1',
    });
    expect(document.paths['/api/v1/workspaces/{workspaceId}/folders'].post).toMatchObject({
      operationId: 'publishFolderV1',
      requestBody: {
        content: { 'multipart/form-data': { schema: { required: ['manifest'] } } },
      },
    });
    expect(document.paths['/api/v1/revisions/{revisionId}/tree'].get).toMatchObject({
      operationId: 'getFolderTreeV1',
    });
    expect(
      document.paths['/api/v1/revisions/{baseRevisionId}/comparisons/{targetRevisionId}'].get,
    ).toMatchObject({
      operationId: 'compareRevisionsV1',
    });
  });

  it('does not couple the CLI to core or API server modules', async () => {
    const sources = await Promise.all(
      [
        '../src/index.ts',
        '../src/client.ts',
        '../src/output.ts',
        '../src/commands/publish.ts',
        '../src/commands/artifacts.ts',
        '../src/commands/folders.ts',
        '../src/commands/revisions.ts',
      ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
    );
    expect(sources.join('\n')).not.toMatch(/@shelf\/core|apps\/api|\.\.\/\.\.\/api/);
  });
});
