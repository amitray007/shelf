export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} kB`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
}

/** Removes only the final extension from the visible file identity. */
export function formatFileDisplayName(fileName: string | undefined): string {
  if (fileName === undefined) return '';
  const separatorIndex = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const extensionIndex = fileName.lastIndexOf('.');
  if (extensionIndex <= separatorIndex + 1) return fileName;
  return fileName.slice(0, extensionIndex);
}

/**
 * Returns the short, stable format label used by the public viewer toolbar.
 * Prefer the filename extension because it is what people recognize, then use
 * the media type when a filename has no extension.
 */
export function formatFileType(
  fileName: string | undefined,
  mediaType: string | undefined,
): string {
  const leaf = fileName?.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const extension = leaf.match(/\.([a-z0-9]+)$/iu)?.[1];
  if (extension !== undefined) return extension.toUpperCase();

  const normalized = mediaType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const subtype = normalized.split('/', 2)[1];
  if (subtype === undefined || subtype === '') return 'FILE';
  return subtype
    .replace(/^x-/u, '')
    .replaceAll(/[^a-z0-9]+/gu, ' ')
    .trim()
    .toUpperCase();
}
