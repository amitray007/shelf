import { describe, expect, it } from 'vitest';

import { createCoreHtmlResolver } from '../src/resolver.js';
import {
  rendererDependencies,
  rendererFolderDependencies,
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

function folderResolver(dependencies: ReturnType<typeof rendererFolderDependencies>) {
  return createCoreHtmlResolver({
    ...dependencies,
    viewerSessionTokenCodec: {
      verify: () => ({
        shareId: rendererIds.share,
        sessionId: rendererIds.sessionId,
        issuedAt: '2026-08-17T12:00:00.000Z',
        accessExpiresAt: '2026-08-18T12:00:00.000Z',
      }),
    },
    clock: () => new Date('2026-08-17T12:30:00.000Z'),
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

  it('reuses validated HTML bytes while checking Public share access on every open', async () => {
    const dependencies = rendererDependencies({
      share: rendererStoredShare({
        accessType: 'public',
        publicCode: rendererIds.publicCode,
      }),
    });
    let reads = 0;
    let revoked = false;
    const originalRead = dependencies.contentReader.read.bind(dependencies.contentReader);
    dependencies.contentReader.read = async (...args) => {
      reads += 1;
      return originalRead(...args);
    };
    const originalResolve = dependencies.shares.resolveShareTarget.bind(dependencies.shares);
    dependencies.shares.resolveShareTarget = async (shareId) => {
      const result = await originalResolve(shareId);
      return revoked && result !== undefined
        ? { ...result, share: { ...result.share, revokedAt: '2026-08-17T12:15:00.000Z' } }
        : result;
    };
    const htmlResolver = createCoreHtmlResolver({
      ...dependencies,
      viewerSessionTokenCodec: { verify: () => undefined },
      clock: () => new Date('2026-08-17T12:30:00.000Z'),
    });
    const request = { accessType: 'public' as const, publicCode: rendererIds.publicCode };

    await expect(htmlResolver.resolveHtml(request)).resolves.toMatchObject({ status: 'available' });
    await expect(htmlResolver.resolveHtml(request)).resolves.toMatchObject({ status: 'available' });
    expect(reads).toBe(1);

    revoked = true;
    await expect(htmlResolver.resolveHtml(request)).resolves.toEqual({ status: 'unavailable' });
    expect(reads).toBe(1);
  });

  it('grants a folder session for an exact HTML entry without reading its bytes', async () => {
    const path = 'site/index.html';
    const dependencies = rendererFolderDependencies({
      [path]: { mediaType: 'text/html', content: new TextEncoder().encode(html) },
    });
    let reads = 0;
    const read = dependencies.contentReader.read;
    dependencies.contentReader.read = async (...args) => {
      reads += 1;
      return read(...args);
    };

    await expect(
      folderResolver(dependencies).resolveHtml({
        accessType: 'protected',
        shareId: rendererIds.share,
        viewerToken,
        path,
      }),
    ).resolves.toEqual({
      status: 'folder',
      authority: {
        type: 'protected-session',
        shareId: rendererIds.share,
        sessionId: rendererIds.sessionId,
      },
      revisionId: rendererIds.revision,
      path,
      accessExpiresAt: Date.parse('2026-08-18T12:00:00.000Z'),
    });
    expect(reads).toBe(0);
  });

  it('does not grant a folder session for a non-HTML entry', async () => {
    const dependencies = rendererFolderDependencies({
      'app.js': { mediaType: 'text/javascript', content: new TextEncoder().encode('1') },
    });

    await expect(
      folderResolver(dependencies).resolveHtml({
        accessType: 'protected',
        shareId: rendererIds.share,
        viewerToken,
        path: 'app.js',
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads sibling files and nested HTML from the granted revision', async () => {
    const script = new TextEncoder().encode('export const ready = true;');
    const resolver = folderResolver(
      rendererFolderDependencies({
        'index.html': { mediaType: 'text/html', content: new TextEncoder().encode(html) },
        'js/app.js': { mediaType: 'text/javascript', content: script },
      }),
    );
    const authority = {
      type: 'protected-session' as const,
      shareId: rendererIds.share,
      sessionId: rendererIds.sessionId,
    };

    const file = await resolver.readFolderFile?.({
      authority,
      revisionId: rendererIds.revision,
      path: 'js/app.js',
    });
    expect(file).toMatchObject({
      kind: 'file',
      mediaType: 'text/javascript',
      byteCount: script.byteLength,
    });
    if (file?.kind !== 'file') throw new Error('expected a file');
    const chunks: Uint8Array[] = [];
    for await (const chunk of await file.read({ start: 7, end: 11 })) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('const');

    await expect(
      resolver.readFolderFile?.({
        authority,
        revisionId: rendererIds.revision,
        path: 'index.html',
      }),
    ).resolves.toEqual({ kind: 'html', html });
    await expect(
      resolver.readFolderFile?.({
        authority,
        revisionId: rendererIds.revision,
        path: 'missing.js',
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.readFolderFile?.({
        authority,
        revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
        path: 'js/app.js',
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { type: 'public', change: 'revoked' },
    { type: 'public', change: 'expired' },
    { type: 'protected-session', change: 'revoked' },
    { type: 'protected-session', change: 'expired' },
  ] as const)(
    'rechecks $type authority and the exact entry when warm HTML becomes $change',
    async ({ type, change }) => {
      const dependencies = rendererFolderDependencies(
        { 'index.html': { mediaType: 'text/html', content: new TextEncoder().encode(html) } },
        {
          share: rendererStoredShare(
            type === 'public' ? { accessType: 'public', publicCode: rendererIds.publicCode } : {},
          ),
        },
      );
      let reads = 0;
      let resolutions = 0;
      let lookups = 0;
      let unavailable = false;
      const read = dependencies.contentReader.read;
      dependencies.contentReader.read = async (...args) => {
        reads += 1;
        return read(...args);
      };
      const resolve = dependencies.shares.resolveShareTarget;
      dependencies.shares.resolveShareTarget = async (...args) => {
        resolutions += 1;
        const target = await resolve(...args);
        return unavailable && target !== undefined
          ? {
              ...target,
              share: {
                ...target.share,
                ...(change === 'revoked'
                  ? { revokedAt: '2026-08-17T12:15:00.000Z' }
                  : { expiresAt: '2026-08-17T12:15:00.000Z' }),
              },
            }
          : target;
      };
      const find = dependencies.folders.findFolderEntry;
      dependencies.folders.findFolderEntry = async (...args) => {
        lookups += 1;
        return find(...args);
      };
      const resolver = folderResolver(dependencies);
      const authority =
        type === 'public'
          ? { type, publicCode: rendererIds.publicCode }
          : { type, shareId: rendererIds.share, sessionId: rendererIds.sessionId };
      const request = { authority, revisionId: rendererIds.revision, path: 'index.html' };

      for (let index = 0; index < 2; index += 1) {
        await expect(resolver.readFolderFile?.(request)).resolves.toEqual({ kind: 'html', html });
      }
      expect({ reads, resolutions, lookups }).toEqual({ reads: 1, resolutions: 2, lookups: 2 });
      await expect(
        resolver.readFolderFile?.({
          ...request,
          authority:
            type === 'public'
              ? { type, publicCode: 'ZbCdEf0123_-' }
              : { type, shareId: 'shr_CCCCCCCCCCCCCCCCCCCCCC', sessionId: rendererIds.sessionId },
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolver.readFolderFile?.({ ...request, path: 'missing.html' }),
      ).resolves.toBeUndefined();
      await expect(
        resolver.readFolderFile?.({ ...request, revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC' }),
      ).resolves.toBeUndefined();
      unavailable = true;
      await expect(resolver.readFolderFile?.(request)).resolves.toBeUndefined();
      expect(reads).toBe(1);
    },
  );

  it('keeps same-size folder HTML entries separate by their content hashes', async () => {
    const resolver = folderResolver(
      rendererFolderDependencies({
        'one.html': { mediaType: 'text/html', content: new TextEncoder().encode('<p>one</p>') },
        'two.html': { mediaType: 'text/html', content: new TextEncoder().encode('<p>two</p>') },
      }),
    );
    const request = {
      authority: {
        type: 'protected-session' as const,
        shareId: rendererIds.share,
        sessionId: rendererIds.sessionId,
      },
      revisionId: rendererIds.revision,
    };
    for (const name of ['one', 'two', 'one']) {
      await expect(
        resolver.readFolderFile?.({ ...request, path: `${name}.html` }),
      ).resolves.toEqual({ kind: 'html', html: `<p>${name}</p>` });
    }
  });

  it('preserves cancellation during a warm-cache entry lookup', async () => {
    const dependencies = rendererFolderDependencies({
      'index.html': { mediaType: 'text/html', content: new TextEncoder().encode(html) },
    });
    const resolver = folderResolver(dependencies);
    const request = {
      authority: {
        type: 'protected-session' as const,
        shareId: rendererIds.share,
        sessionId: rendererIds.sessionId,
      },
      revisionId: rendererIds.revision,
      path: 'index.html',
    };
    await expect(resolver.readFolderFile?.(request)).resolves.toEqual({ kind: 'html', html });
    const controller = new AbortController();
    const find = dependencies.folders.findFolderEntry;
    dependencies.folders.findFolderEntry = async (...args) => {
      const result = await find(...args);
      controller.abort();
      return result;
    };
    await expect(
      resolver.readFolderFile?.({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CONTENT_UNAVAILABLE' });
  });

  it.each(['invalid UTF-8', 'wrong byte count', 'above cache limit'])(
    'does not cache folder HTML with %s',
    async (scenario) => {
      const content =
        scenario === 'invalid UTF-8'
          ? Uint8Array.from([0xc3, 0x28])
          : new TextEncoder().encode(
              scenario === 'above cache limit' ? 'x'.repeat(1_048_577) : html,
            );
      const dependencies = rendererFolderDependencies({
        'index.html': { mediaType: 'text/html', content },
      });
      let reads = 0;
      const read = dependencies.contentReader.read;
      dependencies.contentReader.read = async (...args) => {
        reads += 1;
        if (scenario === 'wrong byte count') {
          return (async function* () {
            yield new Uint8Array();
          })();
        }
        return read(...args);
      };
      const resolver = folderResolver(dependencies);
      const request = {
        authority: {
          type: 'protected-session' as const,
          shareId: rendererIds.share,
          sessionId: rendererIds.sessionId,
        },
        revisionId: rendererIds.revision,
        path: 'index.html',
      };
      for (let index = 0; index < 2; index += 1) {
        const result = await resolver.readFolderFile?.(request);
        if (scenario === 'above cache limit') expect(result?.kind).toBe('html');
        else expect(result).toBeUndefined();
      }
      expect(reads).toBe(2);
    },
  );

  it('keeps serving the issued revision after a newer Latest revision is published', async () => {
    const dependencies = rendererFolderDependencies({
      'js/lazy.js': { mediaType: 'text/javascript', content: new TextEncoder().encode('1') },
    });
    const resolveCurrent = dependencies.shares.resolveShareTarget.bind(dependencies.shares);
    dependencies.shares.resolveShareTarget = async (shareId) => {
      const current = await resolveCurrent(shareId);
      if (current === undefined) return undefined;
      const issued = current.revision;
      const newer = {
        ...issued.revision,
        revisionId: 'rev_CCCCCCCCCCCCCCCCCCCCCC',
        revisionNumber: 2,
      };
      dependencies.shares.findRevisionForShare = async (revisionId) =>
        revisionId === rendererIds.revision ? issued : undefined;
      return {
        ...current,
        artifact: { ...current.artifact, latestRevision: newer },
        revision: { ...issued, revision: newer },
      };
    };

    await expect(
      folderResolver(dependencies).readFolderFile?.({
        authority: {
          type: 'protected-session',
          shareId: rendererIds.share,
          sessionId: rendererIds.sessionId,
        },
        revisionId: rendererIds.revision,
        path: 'js/lazy.js',
      }),
    ).resolves.toMatchObject({ kind: 'file', mediaType: 'text/javascript' });
  });

  it('stops serving folder files once the share is revoked', async () => {
    const resolver = folderResolver(
      rendererFolderDependencies(
        { 'app.js': { mediaType: 'text/javascript', content: new TextEncoder().encode('1') } },
        { share: rendererStoredShare({ revokedAt: '2026-08-17T12:10:00.000Z' }) },
      ),
    );

    await expect(
      resolver.readFolderFile?.({
        authority: {
          type: 'protected-session',
          shareId: rendererIds.share,
          sessionId: rendererIds.sessionId,
        },
        revisionId: rendererIds.revision,
        path: 'app.js',
      }),
    ).resolves.toBeUndefined();
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
