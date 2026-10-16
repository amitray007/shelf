import {
  type ContentReader,
  createShareAccessService,
  type FolderRevisionRepository,
  type RevisionRepository,
  type ShareClock,
  ShareNotFoundError,
  type ShareRepository,
  type ShareResolutionAuthority,
} from '@shelf/core';

import type { RendererHtmlResolver } from './app.js';

export const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_CACHED_HTML_BYTES = 1024 * 1024;
const MAX_HTML_CACHE_BYTES = 32 * 1024 * 1024;

export interface ViewerSessionTokenVerifier {
  verify(
    token: string,
    options: { now: Date; shareId?: string; sessionId?: string; allowExpired?: boolean },
  ): { shareId: string; sessionId: string; issuedAt: string; accessExpiresAt: string } | undefined;
}

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function readExactUtf8(
  content: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
): Promise<string | undefined> {
  if (expectedBytes < 0 || expectedBytes > maximumBytes) return undefined;
  const bytes = new Uint8Array(expectedBytes);
  let byteCount = 0;
  for await (const chunk of content) {
    const nextByteCount = byteCount + chunk.byteLength;
    if (nextByteCount > expectedBytes || nextByteCount > maximumBytes) return undefined;
    bytes.set(chunk, byteCount);
    byteCount = nextByteCount;
  }
  if (byteCount !== expectedBytes) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function createCoreHtmlResolver(dependencies: {
  appOrigin: string;
  shares: ShareRepository;
  viewerSessionTokenCodec: ViewerSessionTokenVerifier;
  revisions: RevisionRepository;
  folders: FolderRevisionRepository;
  contentReader: ContentReader;
  clock?: ShareClock;
  maxHtmlBytes?: number;
}): RendererHtmlResolver {
  const maximumBytes = dependencies.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Renderer maxHtmlBytes must be a positive safe integer.');
  }
  const access = createShareAccessService({
    shares: dependencies.shares,
    revisions: dependencies.revisions,
    folders: dependencies.folders,
    contentReader: dependencies.contentReader,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });
  // Share authority is resolved on every request. Only validated immutable bytes are cached.
  const htmlCache = new Map<string, { html: string; byteCount: number }>();
  let cachedBytes = 0;

  function cachedHtml(hash: string, byteCount: number): string | undefined {
    const cached = htmlCache.get(hash);
    if (cached === undefined || cached.byteCount !== byteCount) return undefined;
    htmlCache.delete(hash);
    htmlCache.set(hash, cached);
    return cached.html;
  }

  function cacheHtml(hash: string, byteCount: number, html: string): void {
    if (byteCount > MAX_CACHED_HTML_BYTES) return;
    const previous = htmlCache.get(hash);
    if (previous !== undefined) {
      cachedBytes -= previous.byteCount;
      htmlCache.delete(hash);
    }
    htmlCache.set(hash, { html, byteCount });
    cachedBytes += byteCount;
    while (cachedBytes > MAX_HTML_CACHE_BYTES) {
      const oldest = htmlCache.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= htmlCache.get(oldest)?.byteCount ?? 0;
      htmlCache.delete(oldest);
    }
  }

  return {
    async resolveHtml(request) {
      try {
        let authority: ShareResolutionAuthority;
        let protectedAccessExpiresAt: number | undefined;
        if (request.accessType === 'public') {
          authority = { type: 'public', publicCode: request.publicCode };
        } else {
          const claims = dependencies.viewerSessionTokenCodec.verify(request.viewerToken, {
            now: dependencies.clock?.() ?? new Date(),
            shareId: request.shareId,
          });
          if (claims === undefined) throw new ShareNotFoundError();
          authority = {
            type: 'protected-session',
            shareId: request.shareId,
            sessionId: claims.sessionId,
          };
          protectedAccessExpiresAt = Date.parse(claims.accessExpiresAt);
        }
        const file =
          request.path === undefined
            ? await access.readFile({
                authority,
                ...(request.revisionId === undefined ? {} : { revisionId: request.revisionId }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              })
            : await access.readTreeFile({
                authority,
                path: request.path,
                ...(request.revisionId === undefined ? {} : { revisionId: request.revisionId }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              });
        if (normalizedMediaType(file.mediaType) !== 'text/html' || file.byteCount > maximumBytes) {
          return { status: 'unavailable' };
        }
        if (request.path !== undefined) {
          // Folder HTML loads through a revision-scoped folder session so the browser resolves
          // sibling scripts, styles, fonts, and media itself. The bytes are read on that request.
          return {
            status: 'folder',
            authority,
            revisionId: file.revisionId,
            path: request.path,
            ...(protectedAccessExpiresAt === undefined
              ? {}
              : { accessExpiresAt: protectedAccessExpiresAt }),
          };
        }
        const html =
          cachedHtml(file.contentHash, file.byteCount) ??
          (await readExactUtf8(await file.read(), file.byteCount, maximumBytes));
        if (html === undefined) return { status: 'unavailable' };
        cacheHtml(file.contentHash, file.byteCount, html);
        return { status: 'available', html };
      } catch (error) {
        if (error instanceof ShareNotFoundError) return { status: 'unavailable' };
        throw error;
      }
    },

    async readFolderFile(request) {
      try {
        const file = await access.readTreeFile({
          authority: request.authority,
          revisionId: request.revisionId,
          path: request.path,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (file.revisionId !== request.revisionId) return undefined;
        if (normalizedMediaType(file.mediaType) === 'text/html') {
          if (file.byteCount > maximumBytes) return undefined;
          const html = await readExactUtf8(await file.read(), file.byteCount, maximumBytes);
          return html === undefined ? undefined : { kind: 'html', html };
        }
        return {
          kind: 'file',
          mediaType: file.mediaType,
          byteCount: file.byteCount,
          read: (range) => file.read(range),
        };
      } catch (error) {
        if (error instanceof ShareNotFoundError) return undefined;
        throw error;
      }
    },
  };
}
