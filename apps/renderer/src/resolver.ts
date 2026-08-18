import {
  type ContentReader,
  createShareAccessService,
  type FolderRevisionRepository,
  type RevisionRepository,
  type ShareClock,
  ShareNotFoundError,
  type ShareRepository,
} from '@shelf/core';

import type { RendererHtmlResolver } from './app.js';

export const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024;

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

  return {
    async resolveHtml(request) {
      try {
        const authority =
          request.accessType === 'public'
            ? { type: 'public' as const, publicCode: request.publicCode }
            : (() => {
                const claims = dependencies.viewerSessionTokenCodec.verify(request.viewerToken, {
                  now: dependencies.clock?.() ?? new Date(),
                  shareId: request.shareId,
                });
                if (claims === undefined) throw new ShareNotFoundError();
                return {
                  type: 'protected-session' as const,
                  shareId: request.shareId,
                  sessionId: claims.sessionId,
                };
              })();
        const file = await access.readFile({
          authority,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        if (normalizedMediaType(file.mediaType) !== 'text/html' || file.byteCount > maximumBytes) {
          return { status: 'unavailable' };
        }
        const html = await readExactUtf8(await file.read(), file.byteCount, maximumBytes);
        return html === undefined ? { status: 'unavailable' } : { status: 'available', html };
      } catch (error) {
        if (error instanceof ShareNotFoundError) return { status: 'unavailable' };
        throw error;
      }
    },
  };
}
