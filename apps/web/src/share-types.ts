import type { PublicShareResolution } from '@shelf/contracts';

export type FileShareResolution = Extract<PublicShareResolution, { artifact: { kind: 'file' } }>;
export type FolderShareResolution = Extract<
  PublicShareResolution,
  { artifact: { kind: 'folder' } }
>;

export function isFileShareResolution(value: PublicShareResolution): value is FileShareResolution {
  return (
    value.artifact.kind === 'file' &&
    value.revision.kind === 'file' &&
    value.action.type === 'content'
  );
}

export function isFolderShareResolution(
  value: PublicShareResolution,
): value is FolderShareResolution {
  return (
    value.artifact.kind === 'folder' &&
    value.revision.kind === 'folder' &&
    value.action.type === 'tree'
  );
}
