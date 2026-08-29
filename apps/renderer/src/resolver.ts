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
import { inlineFolderAssetSources } from './folder-assets.js';

export const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024;
export const RENDERED_HTML_EXPANSION_FACTOR = 3;

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
  const appOrigin = new URL(dependencies.appOrigin).origin;
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
        const html = await readExactUtf8(await file.read(), file.byteCount, maximumBytes);
        if (html === undefined) return { status: 'unavailable' };
        if (request.path === undefined) return { status: 'available', html };
        const renderedHtml = await inlineFolderAssetSources({
          html,
          htmlPath: request.path,
          appOrigin,
          ...(request.accessType === 'public' ? { publicCode: request.publicCode } : {}),
          maximumOutputBytes: maximumBytes * RENDERED_HTML_EXPANSION_FACTOR,
          async readAsset(path) {
            const asset = await access.readTreeFile({
              authority,
              path,
              ...(request.revisionId === undefined ? {} : { revisionId: request.revisionId }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
            return {
              mediaType: asset.mediaType,
              byteCount: asset.byteCount,
              read: () => asset.read(undefined),
            };
          },
        });
        return { status: 'available', html: renderedHtml };
      } catch (error) {
        if (error instanceof ShareNotFoundError) return { status: 'unavailable' };
        throw error;
      }
    },
  };
}
