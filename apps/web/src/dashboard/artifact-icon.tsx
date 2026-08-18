import { FileIcon } from '@phosphor-icons/react/File';
import { FileArchiveIcon } from '@phosphor-icons/react/FileArchive';
import { FileAudioIcon } from '@phosphor-icons/react/FileAudio';
import { FileCodeIcon } from '@phosphor-icons/react/FileCode';
import { FileCsvIcon } from '@phosphor-icons/react/FileCsv';
import { FileHtmlIcon } from '@phosphor-icons/react/FileHtml';
import { FileImageIcon } from '@phosphor-icons/react/FileImage';
import { FileMdIcon } from '@phosphor-icons/react/FileMd';
import { FilePdfIcon } from '@phosphor-icons/react/FilePdf';
import { FileTextIcon } from '@phosphor-icons/react/FileText';
import { FileVideoIcon } from '@phosphor-icons/react/FileVideo';
import { FolderIcon } from '@phosphor-icons/react/Folder';

import { artifactFileType } from './artifact-file-type.js';

const fileIcons = {
  archive: FileArchiveIcon,
  audio: FileAudioIcon,
  code: FileCodeIcon,
  data: FileCsvIcon,
  generic: FileIcon,
  html: FileHtmlIcon,
  image: FileImageIcon,
  json: FileCodeIcon,
  markdown: FileMdIcon,
  pdf: FilePdfIcon,
  text: FileTextIcon,
  video: FileVideoIcon,
} as const;

export function ArtifactIcon({
  kind,
  name,
}: {
  readonly kind: 'file' | 'folder';
  readonly name: string;
}) {
  const Icon = kind === 'folder' ? FolderIcon : fileIcons[artifactFileType(name)];
  return <Icon aria-hidden="true" size={20} weight="regular" />;
}
