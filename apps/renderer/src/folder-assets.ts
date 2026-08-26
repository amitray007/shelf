import { normalizePortableFolderPath, ShareNotFoundError } from '@shelf/core';
import { type DefaultTreeAdapterTypes, parse, serialize } from 'parse5';

const RASTER_MEDIA_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);
const AUDIO_MEDIA_TYPES = new Set([
  'application/ogg',
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);
const VIDEO_MEDIA_TYPES = new Set([
  'application/ogg',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
  'video/webm',
  'video/x-m4v',
]);
const TRACK_MEDIA_TYPES = new Set(['text/vtt']);
const ASSET_SOURCE_GATE = /<(?:audio|img|source|track|video)\b/iu;
const ABSOLUTE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const EMBEDDED_ATTRIBUTES = {
  poster: 'data-shelf-embedded-poster',
  src: 'data-shelf-embedded-src',
} as const;
const EMBEDDED_ATTRIBUTE_NAMES = new Set<string>(Object.values(EMBEDDED_ATTRIBUTES));
const EMBEDDED_SCRIPT_OVERHEAD_BYTES = 2_048;

interface FolderAsset {
  mediaType: string;
  byteCount: number;
  read(): Promise<AsyncIterable<Uint8Array>>;
}

interface AssetReference {
  acceptedMediaTypes: ReadonlySet<string>;
  attribute: DefaultTreeAdapterTypes.Element['attrs'][number];
  element: DefaultTreeAdapterTypes.Element;
  path: string;
  targetAttribute: keyof typeof EMBEDDED_ATTRIBUTES;
}

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function exactPublicAssetPath(
  reference: URL,
  appOrigin: string,
  publicCode: string | undefined,
): string | undefined {
  if (publicCode === undefined || reference.origin !== appOrigin) return undefined;
  const expectedPath = `/api/v1/public/links/${encodeURIComponent(publicCode)}/tree/content/preview`;
  if (reference.pathname !== expectedPath) return undefined;
  const keys = [...reference.searchParams.keys()];
  const paths = reference.searchParams.getAll('path');
  if (keys.some((key) => key !== 'path') || paths.length !== 1 || reference.hash !== '') {
    return undefined;
  }
  return paths[0];
}

function referencedFolderPath(options: {
  value: string;
  htmlPath: string;
  appOrigin: string;
  publicCode?: string;
}): string | undefined {
  const value = options.value.trim();
  if (value === '' || value.startsWith('#') || value.startsWith('//')) return undefined;
  try {
    if (ABSOLUTE_SCHEME.test(value)) {
      const exactPath = exactPublicAssetPath(new URL(value), options.appOrigin, options.publicCode);
      return exactPath === undefined ? undefined : normalizePortableFolderPath(exactPath);
    }

    const reference = new URL(value, new URL(`/${options.htmlPath}`, options.appOrigin));
    if (reference.origin !== options.appOrigin) return undefined;
    const exactPath = exactPublicAssetPath(reference, options.appOrigin, options.publicCode);
    if (exactPath !== undefined) return normalizePortableFolderPath(exactPath);
    const decodedPath = decodeURIComponent(reference.pathname).replace(/^\/+/, '');
    return normalizePortableFolderPath(decodedPath);
  } catch {
    return undefined;
  }
}

function assetReferences(
  html: string,
  options: { htmlPath: string; appOrigin: string; publicCode?: string },
): { document: DefaultTreeAdapterTypes.Document; references: AssetReference[] } | undefined {
  if (!ASSET_SOURCE_GATE.test(html)) return undefined;
  const document = parse(html);
  const references: AssetReference[] = [];
  const addReference = (
    element: DefaultTreeAdapterTypes.Element,
    targetAttribute: keyof typeof EMBEDDED_ATTRIBUTES,
    acceptedMediaTypes: ReadonlySet<string>,
  ): void => {
    const attribute = element.attrs.find((candidate) => candidate.name === targetAttribute);
    if (attribute === undefined) return;
    const path = referencedFolderPath({ value: attribute.value, ...options });
    if (path !== undefined && path !== options.htmlPath) {
      references.push({ acceptedMediaTypes, attribute, element, path, targetAttribute });
    }
  };
  const visit = (node: DefaultTreeAdapterTypes.Node, mediaContext?: 'audio' | 'video'): void => {
    let childMediaContext = mediaContext;
    if ('tagName' in node) {
      if (node.tagName === 'img') {
        addReference(node, 'src', RASTER_MEDIA_TYPES);
      } else if (node.tagName === 'video') {
        addReference(node, 'poster', RASTER_MEDIA_TYPES);
        addReference(node, 'src', VIDEO_MEDIA_TYPES);
        childMediaContext = 'video';
      } else if (node.tagName === 'audio') {
        addReference(node, 'src', AUDIO_MEDIA_TYPES);
        childMediaContext = 'audio';
      } else if (node.tagName === 'source' && mediaContext !== undefined) {
        addReference(node, 'src', mediaContext === 'video' ? VIDEO_MEDIA_TYPES : AUDIO_MEDIA_TYPES);
      } else if (node.tagName === 'track' && mediaContext !== undefined) {
        addReference(node, 'src', TRACK_MEDIA_TYPES);
      }
      if (node.tagName === 'template' && 'content' in node) visit(node.content);
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child, childMediaContext);
    }
  };
  visit(document);
  return { document, references };
}

async function readExactBytes(
  content: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): Promise<Uint8Array | undefined> {
  const bytes = new Uint8Array(expectedBytes);
  let byteCount = 0;
  for await (const chunk of content) {
    const nextByteCount = byteCount + chunk.byteLength;
    if (nextByteCount > expectedBytes) return undefined;
    bytes.set(chunk, byteCount);
    byteCount = nextByteCount;
  }
  return byteCount === expectedBytes ? bytes : undefined;
}

function javascriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function assetBootstrapScript(
  assets: readonly (readonly [string, readonly [string, string]])[],
): string {
  const markers = javascriptLiteral(
    Object.entries(EMBEDDED_ATTRIBUTES).map(([attribute, marker]) => [marker, attribute]),
  );
  const payload = javascriptLiteral(assets);
  return `<script>(()=>{const markers=${markers};const selector=markers.map(([marker])=>\`[\${marker}]\`).join(",");const assets=new Map(${payload});const urls=new Map();const apply=root=>{const elements=[];if(root.matches?.(selector))elements.push(root);root.querySelectorAll?.(selector).forEach(element=>elements.push(element));for(const element of elements)for(const [marker,attribute] of markers){const id=element.getAttribute(marker);const asset=id===null?undefined:assets.get(id);if(asset===undefined)continue;let url=urls.get(id);if(url===undefined){const binary=atob(asset[1]);const bytes=Uint8Array.from(binary,value=>value.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:asset[0]}));urls.set(id,url)}element.setAttribute(attribute,url);element.removeAttribute(marker)}};const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)apply(node)});observer.observe(document,{childList:true,subtree:true});addEventListener("DOMContentLoaded",()=>{if(document.documentElement!==null)apply(document.documentElement);observer.disconnect()},{once:true});addEventListener("pagehide",()=>{for(const url of urls.values())URL.revokeObjectURL(url)},{once:true})})()</script>`;
}

function injectAfterDoctype(html: string, script: string): string {
  const doctype = /^\s*<!doctype\s+html[^>]*>/iu.exec(html);
  return doctype === null
    ? `${script}${html}`
    : `${doctype[0]}${script}${html.slice(doctype[0].length)}`;
}

export async function inlineFolderAssetSources(options: {
  html: string;
  htmlPath: string;
  appOrigin: string;
  publicCode?: string;
  maximumOutputBytes: number;
  readAsset(path: string): Promise<FolderAsset | undefined>;
}): Promise<string> {
  const found = assetReferences(options.html, options);
  if (found === undefined || found.references.length === 0) return options.html;

  const originalByteCount = Buffer.byteLength(options.html);
  let projectedByteCount = originalByteCount + EMBEDDED_SCRIPT_OVERHEAD_BYTES;
  const referencesByPath = Map.groupBy(found.references, (reference) => reference.path);
  const candidates = await Promise.all(
    [...referencesByPath].map(async ([path, references]) => {
      try {
        const asset = await options.readAsset(path);
        if (asset === undefined) return undefined;
        if (!Number.isSafeInteger(asset.byteCount) || asset.byteCount < 0) return undefined;
        const mediaType = normalizedMediaType(asset.mediaType);
        return references.every((reference) => reference.acceptedMediaTypes.has(mediaType))
          ? { asset, mediaType, path, references }
          : undefined;
      } catch (error) {
        if (error instanceof ShareNotFoundError) return undefined;
        throw error;
      }
    }),
  );
  const selected = [];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const { asset, mediaType, references } = candidate;
    const base64Length = 4 * Math.ceil(asset.byteCount / 3);
    const replacementByteCount =
      base64Length +
      mediaType.length +
      references.reduce(
        (total, reference) => total + EMBEDDED_ATTRIBUTES[reference.targetAttribute].length + 16,
        0,
      );
    const replacedByteCount = references.reduce(
      (total, reference) => total + Buffer.byteLength(reference.attribute.value),
      0,
    );
    const nextProjectedByteCount = projectedByteCount - replacedByteCount + replacementByteCount;
    if (nextProjectedByteCount > options.maximumOutputBytes) continue;
    selected.push(candidate);
    projectedByteCount = nextProjectedByteCount;
  }

  const embedded = await Promise.all(
    selected.map(async (candidate, index) => ({
      ...candidate,
      id: String(index),
      bytes: await readExactBytes(await candidate.asset.read(), candidate.asset.byteCount),
    })),
  );
  const available = embedded.flatMap((candidate) =>
    candidate.bytes === undefined ? [] : [{ ...candidate, bytes: candidate.bytes }],
  );
  const markedElements = new Set(
    available.flatMap((candidate) => candidate.references.map((reference) => reference.element)),
  );
  for (const element of markedElements) {
    element.attrs = element.attrs.filter(
      (attribute) => !EMBEDDED_ATTRIBUTE_NAMES.has(attribute.name),
    );
  }
  const assets: Array<readonly [string, readonly [string, string]]> = [];
  for (const { bytes, id, mediaType, references } of available) {
    assets.push([id, [mediaType, Buffer.from(bytes).toString('base64')]]);
    for (const { attribute, element, targetAttribute } of references) {
      element.attrs = element.attrs.filter((candidate) => candidate !== attribute);
      element.attrs.push({ name: EMBEDDED_ATTRIBUTES[targetAttribute], value: id });
    }
  }

  if (assets.length === 0) return options.html;
  const rendered = injectAfterDoctype(serialize(found.document), assetBootstrapScript(assets));
  return Buffer.byteLength(rendered) <= options.maximumOutputBytes ? rendered : options.html;
}
