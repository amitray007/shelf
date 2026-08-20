import { FolderIcon } from '@phosphor-icons/react/Folder';

import { FileTypeIcon } from '../components/file-type-icon.js';

export function ArtifactIcon({
  kind,
  name,
}: {
  readonly kind: 'file' | 'folder';
  readonly name: string;
}) {
  return kind === 'folder' ? (
    <FolderIcon aria-hidden="true" size={20} weight="regular" />
  ) : (
    <FileTypeIcon name={name} size={20} />
  );
}
