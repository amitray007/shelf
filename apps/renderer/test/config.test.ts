import { describe, expect, it } from 'vitest';

import { loadRendererConfig } from '../src/config.js';

describe('renderer configuration', () => {
  it('loads an isolated renderer listener and exact parent application origin', () => {
    expect(
      loadRendererConfig({
        SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example',
        SHELF_RENDERER_HOST: '0.0.0.0',
        SHELF_RENDERER_PORT: '3101',
        SHELF_RENDERER_MAX_HTML_BYTES: '1048576',
      }),
    ).toEqual({
      appOrigin: 'https://shelf.example',
      host: '0.0.0.0',
      port: 3101,
      maxHtmlBytes: 1_048_576,
    });
  });

  it('allows an HTTP loopback parent for local development', () => {
    expect(
      loadRendererConfig({ SHELF_RENDERER_APP_ORIGIN: 'http://127.0.0.1:5173' }),
    ).toMatchObject({ appOrigin: 'http://127.0.0.1:5173', host: '127.0.0.1', port: 3001 });
  });

  it.each([
    ['missing parent origin', {}],
    ['public HTTP parent', { SHELF_RENDERER_APP_ORIGIN: 'http://shelf.example' }],
    ['parent origin path', { SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example/app' }],
    [
      'invalid listener port',
      { SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example', SHELF_RENDERER_PORT: '0' },
    ],
    [
      'invalid active-render byte limit',
      {
        SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example',
        SHELF_RENDERER_MAX_HTML_BYTES: 'Infinity',
      },
    ],
    [
      'active-render byte limit above the hard ceiling',
      {
        SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example',
        SHELF_RENDERER_MAX_HTML_BYTES: String(10 * 1024 * 1024 + 1),
      },
    ],
    [
      'host containing a line break',
      { SHELF_RENDERER_APP_ORIGIN: 'https://shelf.example', SHELF_RENDERER_HOST: 'host\nname' },
    ],
  ])('rejects %s', (_name, environment) => {
    expect(() => loadRendererConfig(environment)).toThrow();
  });
});
