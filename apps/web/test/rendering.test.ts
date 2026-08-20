import { describe, expect, it } from 'vitest';

import { selectRenderer, supportsSourceView } from '../src/rendering.js';

describe('passive renderer selection', () => {
  it.each([
    ['text/plain', 'text'],
    ['text/x-python', 'text'],
    ['application/javascript', 'text'],
    ['application/json', 'json'],
    ['application/problem+json', 'json'],
    ['text/markdown', 'markdown'],
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/gif', 'image'],
    ['image/webp', 'image'],
    ['image/avif', 'image'],
  ] as const)('selects %s as %s', (mediaType, expected) => {
    expect(selectRenderer(mediaType, undefined)).toEqual({ kind: expected });
  });

  it.each(['image/svg+xml', 'application/pdf', 'application/octet-stream', 'video/mp4'])(
    'keeps %s download-only',
    (mediaType) => {
      expect(selectRenderer(mediaType, 'https://renderer.example')).toEqual({ kind: 'download' });
    },
  );

  it('allows HTML only through a validated isolated renderer origin', () => {
    expect(selectRenderer('text/html', undefined)).toEqual({ kind: 'download' });
    expect(selectRenderer('text/html', 'https://renderer.example')).toEqual({
      kind: 'html',
      url: 'https://renderer.example/render',
    });
    expect(selectRenderer('text/html', 'https://renderer.example/render')).toEqual({
      kind: 'download',
    });
  });

  it.each([
    ['text/markdown', true],
    ['text/html', true],
    ['application/json', true],
    ['image/svg+xml', true],
    ['image/png', false],
    ['image/jpeg', false],
    ['application/pdf', false],
  ] as const)('reports whether %s has a readable source view', (mediaType, expected) => {
    expect(supportsSourceView(mediaType)).toBe(expected);
  });
});
