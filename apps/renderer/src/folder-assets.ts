import { normalizePortableFolderPath } from '@shelf/core';
import { type DefaultTreeAdapterTypes, parse, serialize } from 'parse5';

const URL_ATTRIBUTES = new Set(['href', 'poster', 'src']);

/** Encode a portable folder path as URL path segments under a folder session. */
export function folderSessionFileUrl(sessionPath: string, path: string): string {
  return `${sessionPath}${path.split('/').map(encodeURIComponent).join('/')}`;
}

function exactPublicAssetPath(
  value: string,
  appOrigin: string,
  publicCode: string,
): string | undefined {
  let reference: URL;
  try {
    reference = new URL(value.trim(), appOrigin);
  } catch {
    return undefined;
  }
  const expectedPath = `/api/v1/public/links/${encodeURIComponent(publicCode)}/tree/content/preview`;
  if (reference.origin !== appOrigin || reference.pathname !== expectedPath) return undefined;
  const keys = [...reference.searchParams.keys()];
  const paths = reference.searchParams.getAll('path');
  if (keys.some((key) => key !== 'path') || paths.length !== 1 || reference.hash !== '') {
    return undefined;
  }
  try {
    return normalizePortableFolderPath(paths[0] ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Earlier folder HTML could only reach sibling files through this Public link's exact preview
 * URLs on the application origin. Point those references at the same files in the folder session
 * so existing artifacts keep working under the folder CSP.
 */
export function rewritePublicPreviewReferences(options: {
  html: string;
  appOrigin: string;
  publicCode: string;
  sessionPath: string;
}): string {
  if (!options.html.includes(`/api/v1/public/links/${options.publicCode}/tree/content/preview`)) {
    return options.html;
  }
  const document = parse(options.html);
  let changed = false;
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) {
      for (const attribute of node.attrs) {
        if (!URL_ATTRIBUTES.has(attribute.name)) continue;
        const path = exactPublicAssetPath(attribute.value, options.appOrigin, options.publicCode);
        if (path === undefined) continue;
        attribute.value = folderSessionFileUrl(options.sessionPath, path);
        changed = true;
      }
      if (node.tagName === 'template' && 'content' in node) visit(node.content);
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child);
    }
  };
  visit(document);
  return changed ? serialize(document) : options.html;
}
