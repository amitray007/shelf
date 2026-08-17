import { describe, expect, it } from 'vitest';

import { createCoreHtmlResolver } from '../src/resolver.js';
import {
  rendererDependencies,
  rendererIds,
  rendererStoredShare,
} from './support/renderer-dependencies.js';

const secret = 's'.repeat(43);
const html = '<!doctype html><title>Artifact</title><h1>Hello</h1>';

function resolver(options: Parameters<typeof rendererDependencies>[0] = {}, maxHtmlBytes?: number) {
  return createCoreHtmlResolver({
    ...rendererDependencies(options),
    capabilityCodec: {
      deriveSecret: () => secret,
      validateSecret: (_shareId, supplied) => supplied === secret,
    },
    clock: () => new Date('2026-08-17T12:30:00.000Z'),
    ...(maxHtmlBytes === undefined ? {} : { maxHtmlBytes }),
  });
}

describe('core HTML resolver', () => {
  it.each([
    ['latest', rendererStoredShare({ target: { mode: 'latest' } })],
    [
      'pinned',
      rendererStoredShare({
        target: { mode: 'pinned', revisionId: rendererIds.revision },
      }),
    ],
  ])('opens exact UTF-8 text/html bytes for a %s share', async (_mode, share) => {
    const content = new TextEncoder().encode(html);

    await expect(
      resolver({ content, share }).resolveHtml({ shareId: rendererIds.share, secret }),
    ).resolves.toEqual({ status: 'available', html });
  });

  it.each([
    {
      name: 'a non-HTML media type',
      dependencies: { mediaType: 'text/plain' },
      maxHtmlBytes: undefined,
    },
    {
      name: 'invalid UTF-8',
      dependencies: { content: Uint8Array.from([0xc3, 0x28]) },
      maxHtmlBytes: undefined,
    },
    {
      name: 'content that differs from its sealed byte count',
      dependencies: {
        content: new TextEncoder().encode(html),
        readContent: new TextEncoder().encode(`${html}!`),
      },
      maxHtmlBytes: undefined,
    },
    {
      name: 'content above the configured active-render limit',
      dependencies: { content: new TextEncoder().encode(html) },
      maxHtmlBytes: 8,
    },
  ])('rejects $name without returning active content', async ({ dependencies, maxHtmlBytes }) => {
    await expect(
      resolver(dependencies, maxHtmlBytes).resolveHtml({
        shareId: rendererIds.share,
        secret,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
});
