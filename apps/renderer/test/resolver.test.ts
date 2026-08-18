import { describe, expect, it } from 'vitest';

import { createCoreHtmlResolver } from '../src/resolver.js';
import {
  rendererDependencies,
  rendererIds,
  rendererStoredShare,
} from './support/renderer-dependencies.js';

const viewerToken = 'viewer.token';
const html = '<!doctype html><title>Artifact</title><h1>Hello</h1>';

function resolver(options: Parameters<typeof rendererDependencies>[0] = {}, maxHtmlBytes?: number) {
  return createCoreHtmlResolver({
    ...rendererDependencies(options),
    viewerSessionTokenCodec: {
      verify: (token) =>
        token === viewerToken
          ? {
              shareId: rendererIds.share,
              sessionId: rendererIds.sessionId,
              issuedAt: '2026-08-17T12:00:00.000Z',
              accessExpiresAt: '2026-08-18T12:00:00.000Z',
            }
          : undefined,
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
      resolver({ content, share }).resolveHtml({
        accessType: 'protected',
        shareId: rendererIds.share,
        viewerToken,
      }),
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
        accessType: 'protected',
        shareId: rendererIds.share,
        viewerToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('opens Public HTML by selector without bearer authority', async () => {
    const share = rendererStoredShare({
      accessType: 'public',
      publicCode: rendererIds.publicCode,
      expiresAt: '2026-08-18T12:30:00.000Z',
    });
    await expect(
      resolver({ share }).resolveHtml({
        accessType: 'public',
        publicCode: rendererIds.publicCode,
      }),
    ).resolves.toEqual({ status: 'available', html: '<!doctype html><h1>Artifact</h1>' });
  });

  it('rejects cross-share viewer-token replay and revalidates revocation after issuance', async () => {
    await expect(
      resolver().resolveHtml({
        accessType: 'protected',
        shareId: `shr_${'Z'.repeat(22)}`,
        viewerToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      resolver({
        share: rendererStoredShare({ revokedAt: '2026-08-17T12:15:00.000Z' }),
      }).resolveHtml({
        accessType: 'protected',
        shareId: rendererIds.share,
        viewerToken,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });
});
