import {
  type ContentReader,
  createShareAccessService,
  type FolderRevisionRepository,
  type RevisionRepository,
  type ShareCapabilityCodec,
  type ShareClock,
  ShareNotFoundError,
  type ShareRepository,
} from '@shelf/core';

import type { RendererHtmlResolver } from './app.js';

export const DEFAULT_MAX_HTML_BYTES = 10 * 1024 * 1024;

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function readExactUtf8(
  content: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
): Promise<string | undefined> {
  if (expectedBytes < 0 || expectedBytes > maximumBytes) return undefined;
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  for await (const chunk of content) {
    byteCount += chunk.byteLength;
    if (byteCount > expectedBytes || byteCount > maximumBytes) return undefined;
    chunks.push(chunk);
  }
  if (byteCount !== expectedBytes) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return undefined;
  }
}

export function createCoreHtmlResolver(dependencies: {
  shares: ShareRepository;
  capabilityCodec: ShareCapabilityCodec;
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
    capabilityCodec: dependencies.capabilityCodec,
    revisions: dependencies.revisions,
    folders: dependencies.folders,
    contentReader: dependencies.contentReader,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });

  return {
    async resolveHtml(request) {
      try {
        const file = await access.readFile(request);
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
