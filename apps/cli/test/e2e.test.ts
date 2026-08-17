import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('CLI wire contract', () => {
  it('is backed by the checked OpenAPI publish operation', async () => {
    const document = JSON.parse(
      await readFile(new URL('../../api/openapi/v1.json', import.meta.url), 'utf8'),
    );
    expect(document.paths['/api/v1/workspaces/{workspaceId}/artifacts'].post).toMatchObject({
      operationId: 'publishFileV1',
      security: [{ bearerAuth: [] }],
      requestBody: {
        content: { 'multipart/form-data': { schema: { required: ['file'] } } },
      },
    });
  });

  it('does not couple the CLI to core or API server modules', async () => {
    const sources = await Promise.all(
      ['../src/index.ts', '../src/client.ts', '../src/output.ts', '../src/commands/publish.ts'].map(
        (path) => readFile(new URL(path, import.meta.url), 'utf8'),
      ),
    );
    expect(sources.join('\n')).not.toMatch(/@shelf\/core|apps\/api|\.\.\/\.\.\/api/);
  });
});
